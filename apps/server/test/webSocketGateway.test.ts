import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import { PIECE_KINDS } from "../../../packages/game-core/src/types.ts";
import {
  PROTOCOL_VERSION
} from "../../../packages/protocol/src/messages.ts";
import { createTetrServer } from "../src/serverApp.ts";
import type { TetrServerApp } from "../src/serverApp.ts";
import {
  WebSocketProbe,
  type MessageOf
} from "./support/webSocketProbe.ts";

const ORIGIN = "http://integration.test";
const HOST = "integration.test";
const SUBPROTOCOL = "tetr-d.v3";
const MESSAGE_TIMEOUT_MS = 5_000;
const MATCH_TIMEOUT_MS = 8_000;

interface Fixture {
  readonly app: TetrServerApp;
  readonly url: string;
  readonly clients: WebSocketProbe[];
  readonly errors: unknown[];
  open(): Promise<WebSocketProbe>;
}

async function setup(t: TestContext): Promise<Fixture> {
  assert.equal(PROTOCOL_VERSION, 3);
  const errors: unknown[] = [];
  const clients: WebSocketProbe[] = [];
  const app = createTetrServer({
    allowedOrigins: [ORIGIN],
    allowedHosts: [HOST],
    sessionHmacKey: Buffer.alloc(32, 0x5a),
    helloTimeoutMs: 2_000,
    onError: (error) => errors.push(error)
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const url = `ws://127.0.0.1:${address.port}/ws`;
  t.after(async () => {
    for (const client of clients) client.terminate();
    await app.close();
  });
  return {
    app,
    url,
    clients,
    errors,
    async open() {
      const client = await WebSocketProbe.open(url, {
        origin: ORIGIN,
        host: HOST,
        subprotocol: SUBPROTOCOL,
        timeoutMs: MESSAGE_TIMEOUT_MS
      });
      clients.push(client);
      return client;
    }
  };
}

async function authenticateGuest(
  client: WebSocketProbe,
  displayName: string
): Promise<MessageOf<"auth.ok">> {
  client.send({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    buildId: "integration-test"
  });
  await client.waitFor("welcome");
  client.send({ type: "auth.guest", displayName });
  return client.waitFor("auth.ok");
}

function assertSevenBagWindow(window: readonly string[]): void {
  const expected = [...PIECE_KINDS].sort();
  assert.ok(window.length >= 7);
  assert.equal(window.length % 7, 0);
  for (let offset = 0; offset < window.length; offset += 7) {
    assert.deepEqual([...window.slice(offset, offset + 7)].sort(), expected);
  }
}

test("two guests play one authoritative shared-bag match", {
  timeout: 15_000
}, async (t) => {
  const fixture = await setup(t);
  const alice = await fixture.open();
  const bob = await fixture.open();
  await authenticateGuest(alice, "Alice");
  await authenticateGuest(bob, "Bob");

  alice.send({ type: "room.create", requestId: "create-alice" });
  const created = await alice.waitFor(
    "room.command.ok",
    (message) => message.requestId === "create-alice"
  );
  const aliceRoom = await alice.waitFor(
    "room.state",
    (message) => message.state.roomId === created.roomId
  );

  bob.send({
    type: "room.join",
    requestId: "join-bob",
    roomCode: aliceRoom.state.roomCode,
    participation: "player",
    preferredSeat: 1
  });
  const joined = await bob.waitFor(
    "room.command.ok",
    (message) => message.requestId === "join-bob"
  );
  await bob.waitFor(
    "room.state",
    (message) => message.state.seats[1]?.displayName === "Bob"
  );

  alice.send({
    type: "room.ready.set",
    requestId: "ready-alice",
    roomId: created.roomId,
    expectedRevision: joined.revision,
    ready: true
  });
  const aliceReady = await alice.waitFor(
    "room.command.ok",
    (message) => message.requestId === "ready-alice"
  );
  bob.send({
    type: "room.ready.set",
    requestId: "ready-bob",
    roomId: created.roomId,
    expectedRevision: aliceReady.revision,
    ready: true
  });
  await bob.waitFor(
    "room.command.ok",
    (message) => message.requestId === "ready-bob"
  );

  const [aliceStart, bobStart] = await Promise.all([
    alice.waitFor("match.start", undefined, MATCH_TIMEOUT_MS),
    bob.waitFor("match.start", undefined, MATCH_TIMEOUT_MS)
  ]);
  assert.equal(
    aliceStart.pieceSequenceCommitment,
    bobStart.pieceSequenceCommitment
  );
  assert.match(aliceStart.pieceSequenceCommitment, /^[a-f0-9]{64}$/);
  assert.equal(aliceStart.selfPieceCursor, 0);
  assert.equal(bobStart.selfPieceCursor, 0);
  assert.deepEqual(aliceStart.selfPieceWindow, bobStart.selfPieceWindow);
  assertSevenBagWindow(aliceStart.selfPieceWindow);

  const playing = await alice.waitFor(
    "room.state",
    (message) => message.state.activeMatch?.matchId === aliceStart.matchId
  );
  assert.equal(aliceStart.simulationHz, 240);
  assert.notEqual(aliceStart.inputEpoch, null);
  alice.send({
    type: "match.input",
    matchId: aliceStart.matchId,
    inputEpoch: aliceStart.inputEpoch!,
    sequence: 0,
    clientFrame: aliceStart.serverFrame,
    actions: [{ kind: "hardDrop" }]
  });
  const acknowledgement = await alice.waitFor(
    "match.inputAck",
    (message) => message.matchId === aliceStart.matchId
  );
  assert.equal(
    acknowledgement.acknowledgement.dispositions[0]?.status,
    "scheduled"
  );
  const snapshot = await alice.waitFor(
    "match.snapshot",
    (message) =>
      message.matchId === aliceStart.matchId &&
      (message.self?.pieceCursor ?? 0) >= 2,
    MATCH_TIMEOUT_MS
  );
  assert.equal(snapshot.self?.playerId, playing.state.self.playerId);

  alice.send({
    type: "match.forfeit",
    requestId: "forfeit-alice",
    roomId: created.roomId,
    matchId: aliceStart.matchId,
    expectedRevision: playing.state.revision
  });
  const [aliceEnd, bobEnd] = await Promise.all([
    alice.waitFor("match.end", (message) =>
      message.matchId === aliceStart.matchId
    ),
    bob.waitFor("match.end", (message) =>
      message.matchId === aliceStart.matchId
    )
  ]);
  assert.equal(aliceEnd.reason, "forfeit");
  assert.equal(aliceEnd.winnerPlayerId, bobEnd.winnerPlayerId);
  assert.equal(
    aliceEnd.pieceSequenceReveal.seedHex,
    bobEnd.pieceSequenceReveal.seedHex
  );
  const settled = await alice.waitFor(
    "room.state",
    (message) =>
      message.state.roomId === created.roomId &&
      message.state.revision > playing.state.revision &&
      message.state.activeMatch === null &&
      message.state.phase !== "playing"
  );
  assert.equal(settled.state.series?.wins[1], 1);
  assert.deepEqual(fixture.errors, []);
});

test("resume token rotates once and supersedes the old socket", {
  timeout: 10_000
}, async (t) => {
  const fixture = await setup(t);
  const original = await fixture.open();
  const issued = await authenticateGuest(original, "Alice");

  const resumed = await fixture.open();
  resumed.send({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    buildId: "integration-test",
    resumeToken: issued.resumeToken
  });
  await resumed.waitFor("welcome");
  const rotated = await resumed.waitFor("auth.ok");
  assert.notEqual(rotated.resumeToken, issued.resumeToken);
  assert.deepEqual(await original.waitForClose(), {
    code: 4001,
    reason: "superseded"
  });

  const replay = await fixture.open();
  replay.send({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    buildId: "integration-test",
    resumeToken: issued.resumeToken
  });
  await replay.waitFor("welcome");
  const rejected = await replay.waitFor("error");
  assert.equal(rejected.code, "AUTH_REQUIRED");
  assert.equal(resumed.socket.readyState, WebSocket.OPEN);
  assert.deepEqual(fixture.errors, []);
});

test("protocol mismatch is rejected after a valid WebSocket upgrade", {
  timeout: 8_000
}, async (t) => {
  const fixture = await setup(t);
  const client = await fixture.open();
  client.send({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION - 1,
    buildId: "outdated-client"
  });

  const error = await client.waitFor("error");
  assert.equal(error.code, "PROTOCOL_MISMATCH");
  assert.equal(error.retryable, false);
  assert.deepEqual(await client.waitForClose(), {
    code: 1002,
    reason: "protocol mismatch"
  });
});
