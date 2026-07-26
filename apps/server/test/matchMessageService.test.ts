import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { ServerMessage } from "../../../packages/protocol/src/messages.ts";
import type { ConnectionTransport } from "../src/gateway/connectionHub.ts";
import { createTetrServer } from "../src/serverApp.ts";

class FakeTransport implements ConnectionTransport {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  send(payload: string): void { this.sent.push(payload); }
  close(): void {}
  clear(): void { this.sent.length = 0; }
}

type MessageOf<Type extends ServerMessage["type"]> = Extract<
  ServerMessage,
  { readonly type: Type }
>;

function messages<Type extends ServerMessage["type"]>(
  transport: FakeTransport,
  type: Type
): MessageOf<Type>[] {
  return transport.sent
    .map((payload) => JSON.parse(payload) as ServerMessage)
    .filter((message): message is MessageOf<Type> => message.type === type);
}

function lastMessage<Type extends ServerMessage["type"]>(
  transport: FakeTransport,
  type: Type
): MessageOf<Type> {
  const message = messages(transport, type).at(-1);
  assert.notEqual(message, undefined, `Missing ${type} message.`);
  return message!;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not reached.");
}

async function createActiveMatch(t: TestContext) {
  let nowMs = 1_000;
  const errors: unknown[] = [];
  const app = createTetrServer({
    allowUnsafeDevelopmentAccess: true,
    matchTickRateHz: 60,
    now: () => nowMs,
    onError: (error) => errors.push(error)
  });
  t.after(() => app.close());

  const aliceTransport = new FakeTransport();
  const bobTransport = new FakeTransport();
  const spectatorTransport = new FakeTransport();
  const alice = app.service.createGuest(
    "connection-alice", aliceTransport, "Alice"
  );
  const bob = app.service.createGuest(
    "connection-bob", bobTransport, "Bob"
  );
  const spectator = app.service.createGuest(
    "connection-spectator", spectatorTransport, "Spectator"
  );

  await app.service.handleMessage(alice.context, {
    type: "room.create",
    requestId: "create-room",
    settings: { targetWins: 1, allowSpectators: true }
  });
  const created = lastMessage(aliceTransport, "room.state").state;
  const roomId = created.roomId;

  await app.service.handleMessage(bob.context, {
    type: "room.join",
    requestId: "join-bob",
    roomCode: created.roomCode,
    participation: "player",
    preferredSeat: 1
  });
  await app.service.handleMessage(spectator.context, {
    type: "room.join",
    requestId: "join-spectator",
    roomCode: created.roomCode,
    participation: "spectator"
  });

  let room = app.rooms.getById(roomId)!;
  await app.service.handleMessage(alice.context, {
    type: "room.ready.set",
    requestId: "ready-alice",
    roomId,
    expectedRevision: room.state.revision,
    ready: true
  });
  room = app.rooms.getById(roomId)!;
  await app.service.handleMessage(bob.context, {
    type: "room.ready.set",
    requestId: "ready-bob",
    roomId,
    expectedRevision: room.state.revision,
    ready: true
  });

  room = app.rooms.getById(roomId)!;
  assert.equal(room.state.phase, "countdown");
  assert.notEqual(room.state.countdown, null);
  nowMs = room.state.countdown!.startsAtMs;
  const matchId = "match-message-service";
  const started = await app.rooms.dispatchSystem(roomId, {
    type: "timer.countdown_elapsed",
    countdownId: room.state.countdown!.countdownId,
    matchId
  });
  assert.equal(started?.receipt.kind, "committed");
  assert.equal(app.rooms.getById(roomId)?.state.phase, "playing");
  assert.notEqual(app.matches.get(matchId), null);

  for (const transport of [
    aliceTransport,
    bobTransport,
    spectatorTransport
  ]) {
    transport.clear();
  }

  return {
    app,
    errors,
    roomId,
    matchId,
    alice,
    bob,
    spectator,
    aliceTransport,
    bobTransport,
    spectatorTransport
  };
}

test("participant input is acknowledged, spectator input is rejected, and resync returns a safe snapshot", async (t) => {
  const fixture = await createActiveMatch(t);
  const match = fixture.app.matches.get(fixture.matchId)!;

  await fixture.app.service.handleMessage(fixture.alice.context, {
    type: "match.input",
    matchId: fixture.matchId,
    inputEpoch: 0,
    sequence: 0,
    clientFrame: match.view.serverFrame,
    actions: [{ kind: "rotate", direction: "cw" }]
  });
  const acknowledgement = lastMessage(
    fixture.aliceTransport,
    "match.inputAck"
  );
  assert.equal(acknowledgement.matchId, fixture.matchId);
  assert.equal(acknowledgement.acknowledgement.inputEpoch, 0);
  assert.equal(acknowledgement.acknowledgement.receivedThroughSequence, 0);
  const disposition = acknowledgement.acknowledgement.dispositions[0];
  assert.equal(disposition?.status, "scheduled");
  if (disposition?.status !== "scheduled") {
    throw new Error("Expected a scheduled input acknowledgement.");
  }
  assert.deepEqual(acknowledgement.acknowledgement.dispositions, [
    {
      sequence: 0,
      status: "scheduled",
      serverFrame: disposition.serverFrame
    }
  ]);
  assert.equal(
    disposition.serverFrame > match.view.serverFrame,
    true
  );
  assert.equal(
    messages(fixture.spectatorTransport, "match.inputAck").length,
    0
  );

  await fixture.app.service.handleMessage(fixture.spectator.context, {
    type: "match.input",
    matchId: fixture.matchId,
    inputEpoch: 0,
    sequence: 0,
    clientFrame: match.view.serverFrame,
    actions: [{ kind: "hardDrop" }]
  });
  const rejected = lastMessage(fixture.spectatorTransport, "error");
  assert.equal(rejected.code, "NOT_SEATED");
  assert.equal(
    messages(fixture.spectatorTransport, "match.inputAck").length,
    0
  );

  fixture.spectatorTransport.clear();
  await fixture.app.service.handleMessage(fixture.spectator.context, {
    type: "match.resyncRequest",
    matchId: fixture.matchId,
    lastStateSequence: 0,
    lastEventSequence: 0
  });
  const snapshot = lastMessage(fixture.spectatorTransport, "match.snapshot");
  assert.equal(snapshot.matchId, fixture.matchId);
  assert.equal(snapshot.players.length, 2);
  assert.equal(snapshot.self, null);
  assert.equal(snapshot.selfStateHash, null);
  assert.deepEqual(fixture.errors, []);
});

test("forfeit rejects a stale revision, then ends the match and settles the room", async (t) => {
  const fixture = await createActiveMatch(t);
  const playing = fixture.app.rooms.getById(fixture.roomId)!.state;

  await fixture.app.service.handleMessage(fixture.alice.context, {
    type: "match.forfeit",
    requestId: "stale-forfeit",
    roomId: fixture.roomId,
    matchId: fixture.matchId,
    expectedRevision: playing.revision + 1
  });
  const conflict = lastMessage(fixture.aliceTransport, "error");
  assert.equal(conflict.code, "REVISION_CONFLICT");
  assert.equal(conflict.requestId, "stale-forfeit");
  assert.equal(conflict.currentRevision, playing.revision);
  assert.equal(conflict.retryable, true);
  assert.equal(messages(fixture.aliceTransport, "match.end").length, 0);
  assert.equal(
    fixture.app.rooms.getById(fixture.roomId)?.state.activeMatch?.matchId,
    fixture.matchId
  );

  fixture.aliceTransport.clear();
  await fixture.app.service.handleMessage(fixture.alice.context, {
    type: "match.forfeit",
    requestId: "valid-forfeit",
    roomId: fixture.roomId,
    matchId: fixture.matchId,
    expectedRevision: playing.revision
  });
  await waitUntil(
    () => fixture.app.rooms.getById(fixture.roomId)?.state.activeMatch === null
  );

  for (const transport of [
    fixture.aliceTransport,
    fixture.bobTransport,
    fixture.spectatorTransport
  ]) {
    const ended = lastMessage(transport, "match.end");
    assert.equal(ended.matchId, fixture.matchId);
    assert.equal(ended.reason, "forfeit");
    assert.equal(ended.winnerPlayerId, fixture.bob.context.player.playerId);
    assert.equal(ended.pieceSequenceReveal.matchId, fixture.matchId);
  }

  const settled = fixture.app.rooms.getById(fixture.roomId)!.state;
  assert.equal(settled.phase, "series_complete");
  assert.equal(settled.activeMatch, null);
  assert.deepEqual(settled.series?.wins, [0, 1]);
  assert.equal(
    settled.series?.winnerPlayerId,
    fixture.bob.context.player.playerId
  );
  assert.deepEqual(fixture.errors, []);
});
