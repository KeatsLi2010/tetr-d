import assert from "node:assert/strict";
import test from "node:test";

import {
  createRoom,
  transitionRoom
} from "../../../packages/room-core/src/room.ts";
import type {
  ServerMessage
} from "../../../packages/protocol/src/messages.ts";
import { SessionStore } from "../src/auth/sessionStore.ts";
import { createResumeToken } from "../src/auth/token.ts";
import {
  ConnectionHub,
  type ConnectionTransport
} from "../src/gateway/connectionHub.ts";
import type {
  FixedStepClock,
  FixedStepScheduler
} from "../src/matches/fixedStepLoop.ts";
import { MatchRegistry } from "../src/matches/matchRegistry.ts";

class FakeTransport implements ConnectionTransport {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: { readonly code: number; readonly reason: string }[] = [];

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
}

const FROZEN_CLOCK: FixedStepClock = Object.freeze({
  nowNs: () => 0n
});

class DormantScheduler implements FixedStepScheduler {
  schedule(_delayMs: number, callback: () => void): unknown {
    return { callback };
  }

  cancel(_handle: unknown): void {}
}

function lastMatchType(transport: FakeTransport): ServerMessage["type"] {
  const payload = transport.sent.at(-1);
  assert.notEqual(payload, undefined);
  return (JSON.parse(payload!) as ServerMessage).type;
}

test("registry drops a rejected delta baseline and fences generations", (t) => {
  let tokenByte = 1;
  let sessionNumber = 0;
  let playerNumber = 0;
  const sessions = new SessionStore({
    hmacKey: Buffer.alloc(32, 0x41),
    now: () => 1_000,
    tokenFactory: () =>
      createResumeToken(() => Buffer.alloc(32, tokenByte++)),
    sessionIdFactory: () => `session-${++sessionNumber}`,
    playerIdFactory: () => `player-${++playerNumber}`
  });
  const alice = sessions.createGuest({
    displayName: "Alice",
    connectionId: "alice-0"
  });
  const bob = sessions.createGuest({
    displayName: "Bob",
    connectionId: "bob-0"
  });
  assert.equal(sessions.bindRoom(alice.session.sessionId, "room-delta"), true);
  assert.equal(sessions.bindRoom(bob.session.sessionId, "room-delta"), true);

  let room = createRoom({
    roomId: "room-delta",
    roomCode: "DEK234",
    creator: {
      playerId: alice.session.playerId,
      displayName: "Alice"
    },
    connectionId: "alice-0",
    nowMs: 1_000
  });
  const joined = transitionRoom(room, {
    type: "member.join",
    requestId: "join-bob",
    player: {
      playerId: bob.session.playerId,
      displayName: "Bob"
    },
    connectionId: "bob-0",
    participation: "player",
    preferredSeat: 1,
    atMs: 1_001
  });
  assert.equal(joined.kind, "committed");
  if (joined.kind !== "committed") throw new Error("Bob did not join.");
  room = joined.state;

  const connections = new ConnectionHub({
    maxBufferedBytes: 1_000_000,
    onBackpressure: () => "reject"
  });
  const aliceTransport = new FakeTransport();
  const bobTransport = new FakeTransport();
  connections.bind({
    sessionId: alice.session.sessionId,
    connectionId: "alice-0",
    connectionGeneration: 0,
    roomId: room.roomId,
    transport: aliceTransport
  });
  connections.bind({
    sessionId: bob.session.sessionId,
    connectionId: "bob-0",
    connectionGeneration: 0,
    roomId: room.roomId,
    transport: bobTransport
  });

  const errors: unknown[] = [];
  const registry = new MatchRegistry({
    sessions,
    connections,
    tickRateHz: 240,
    snapshotRateHz: 30,
    getRoomState: () => room,
    onMatchFinished: () => undefined,
    clock: FROZEN_CLOCK,
    scheduler: new DormantScheduler(),
    onError: (error) => errors.push(error)
  });
  t.after(() => registry.dispose());
  const match = registry.start({
    matchId: "match-delta",
    roomId: room.roomId,
    participants: [alice.session.playerId, bob.session.playerId],
    players: [
      { playerId: alice.session.playerId, displayName: "Alice" },
      { playerId: bob.session.playerId, displayName: "Bob" }
    ]
  });

  assert.equal(
    registry.sendSnapshot(alice.session.playerId, match.view.matchId),
    true
  );
  assert.equal(lastMatchType(aliceTransport), "match.snapshot");
  aliceTransport.bufferedAmount = 1_000_000;
  for (let frame = 0; frame < 8; frame += 1) match.advanceOneFrame();
  assert.equal(aliceTransport.sent.length, 1);

  aliceTransport.bufferedAmount = 0;
  for (let frame = 0; frame < 8; frame += 1) match.advanceOneFrame();
  assert.equal(lastMatchType(aliceTransport), "match.snapshot");
  for (let frame = 0; frame < 8; frame += 1) match.advanceOneFrame();
  assert.equal(lastMatchType(aliceTransport), "match.delta");

  const resumed = sessions.resume({
    resumeToken: alice.resumeToken,
    newConnectionId: "alice-1"
  });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) throw new Error("Alice did not resume.");
  const replacement = new FakeTransport();
  connections.bind({
    sessionId: resumed.session.sessionId,
    connectionId: "alice-1",
    connectionGeneration: resumed.session.connectionGeneration,
    roomId: room.roomId,
    transport: replacement
  });
  for (let frame = 0; frame < 8; frame += 1) match.advanceOneFrame();
  assert.equal(lastMatchType(replacement), "match.snapshot");
  assert.deepEqual(errors, []);
});
