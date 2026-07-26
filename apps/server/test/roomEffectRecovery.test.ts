import assert from "node:assert/strict";
import test from "node:test";

import type {
  RoomCommand,
  RoomState
} from "../../../packages/room-core/src/model.ts";
import {
  createRoom,
  transitionRoom
} from "../../../packages/room-core/src/room.ts";
import type {
  ServerMessage
} from "../../../packages/protocol/src/messages.ts";
import {
  SessionStore
} from "../src/auth/sessionStore.ts";
import {
  ConnectionHub
} from "../src/gateway/connectionHub.ts";
import type {
  ConnectionTransport
} from "../src/gateway/connectionHub.ts";
import {
  RoomEffectProcessor
} from "../src/rooms/roomEffectProcessor.ts";
import type {
  RoomRuntimeCommit
} from "../src/rooms/roomRuntime.ts";

class FakeTransport implements ConnectionTransport {
  bufferedAmount = 0;
  failSend = false;
  readonly sent: string[] = [];

  send(payload: string): void {
    if (this.failSend) throw new Error("simulated send failure");
    this.sent.push(payload);
  }

  close(): void {}

  clear(): void {
    this.sent.length = 0;
  }
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

function apply(
  state: RoomState,
  command: RoomCommand
): { readonly state: RoomState; readonly commit: RoomRuntimeCommit } {
  const result = transitionRoom(state, command);
  assert.equal(result.kind, "committed");
  if (result.kind !== "committed") {
    throw new Error("Expected a committed room transition.");
  }
  return {
    state: result.state,
    commit: {
      before: state,
      after: result.state,
      effects: result.effects
    }
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("Condition was not reached.");
}

interface Fixture {
  state: RoomState;
  processor: RoomEffectProcessor;
  readonly sessions: SessionStore;
  readonly hub: ConnectionHub;
  readonly host: ReturnType<SessionStore["createGuest"]>;
  readonly guest: ReturnType<SessionStore["createGuest"]>;
  readonly hostTransport: FakeTransport;
  readonly guestTransport: FakeTransport;
}

function fixture(): Fixture {
  let sessionNumber = 0;
  let playerNumber = 0;
  const sessions = new SessionStore({
    hmacKey: Buffer.alloc(32, 7),
    now: () => 1_000,
    sessionIdFactory: () => `session-${++sessionNumber}`,
    playerIdFactory: () => `player-${++playerNumber}`
  });
  const host = sessions.createGuest({
    displayName: "Host",
    connectionId: "connection-host"
  });
  const guest = sessions.createGuest({
    displayName: "Guest",
    connectionId: "connection-guest"
  });
  let state = createRoom({
    roomId: "recovery-room",
    roomCode: "REC234",
    creator: host.session,
    connectionId: host.session.activeConnectionId!,
    nowMs: 1_000
  });
  state = apply(state, {
    type: "member.join",
    requestId: "join-guest",
    player: guest.session,
    connectionId: guest.session.activeConnectionId!,
    participation: "player",
    atMs: 1_100
  }).state;
  const hub = new ConnectionHub();
  const hostTransport = new FakeTransport();
  const guestTransport = new FakeTransport();
  const context = {
    state,
    sessions,
    hub,
    host,
    guest,
    hostTransport,
    guestTransport
  } as Fixture;
  for (const [issued, transport] of [
    [host, hostTransport],
    [guest, guestTransport]
  ] as const) {
    sessions.bindRoom(issued.session.sessionId, state.roomId);
    hub.bind({
      sessionId: issued.session.sessionId,
      connectionId: issued.session.activeConnectionId!,
      connectionGeneration: issued.session.connectionGeneration,
      roomId: state.roomId,
      transport
    });
  }
  context.processor = new RoomEffectProcessor({
    sessions,
    connections: hub,
    getRoomState: () => context.state,
    removeRoom: () => false
  });
  return context;
}

function enqueue(context: Fixture, command: RoomCommand): RoomRuntimeCommit {
  const result = apply(context.state, command);
  context.state = result.state;
  context.processor.enqueue(result.commit);
  return result.commit;
}

async function readyBoth(
  context: Fixture,
  requestPrefix: string,
  atMs: number
): Promise<NonNullable<RoomState["countdown"]>> {
  for (const [index, issued] of [
    context.host,
    context.guest
  ].entries()) {
    enqueue(context, {
      type: "ready.set",
      requestId: `${requestPrefix}-${index}`,
      actorPlayerId: issued.session.playerId,
      expectedRevision: context.state.revision,
      ready: true,
      atMs: atMs + index
    });
    await waitUntil(() => context.processor.pendingCount === 0);
  }
  assert.notEqual(context.state.countdown, null);
  return context.state.countdown!;
}

test("resume replays the original match start after send failure", async (t) => {
  const context = fixture();
  t.after(() => context.processor.dispose());
  const countdown = await readyBoth(context, "round-one", 2_000);
  context.hostTransport.clear();
  context.guestTransport.clear();
  context.guestTransport.failSend = true;
  enqueue(context, {
    type: "timer.countdown_elapsed",
    countdownId: countdown.countdownId,
    matchId: "match-recovery",
    atMs: countdown.startsAtMs
  });
  await waitUntil(() => context.processor.pendingCount === 0);

  const originalStart = messages(
    context.hostTransport,
    "match.start"
  )[0];
  assert.ok(originalStart);
  assert.equal(messages(context.guestTransport, "match.start").length, 0);
  assert.equal(context.processor.matchCount, 1);
  const originalSequence =
    context.processor.getMatchPieceSequence("match-recovery");
  assert.notEqual(originalSequence, null);
  assert.equal(
    context.processor.replayMatchStartForPlayer(
      context.guest.session.playerId
    ),
    false
  );

  const resumed = context.sessions.resume({
    resumeToken: context.guest.resumeToken,
    newConnectionId: "connection-guest-resumed"
  });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  const resumedTransport = new FakeTransport();
  context.hub.bind({
    sessionId: resumed.session.sessionId,
    connectionId: resumed.session.activeConnectionId!,
    connectionGeneration: resumed.session.connectionGeneration,
    roomId: context.state.roomId,
    transport: resumedTransport
  });
  assert.equal(
    context.processor.replayMatchStartForPlayer(
      context.guest.session.playerId
    ),
    true
  );

  const replayedStart = messages(resumedTransport, "match.start")[0];
  assert.ok(replayedStart);
  assert.deepEqual(
    { ...replayedStart, inputEpoch: originalStart.inputEpoch },
    originalStart
  );
  assert.equal(originalStart.inputEpoch, 0);
  assert.equal(replayedStart.inputEpoch, 1);
  assert.equal(replayedStart.selfPieceCursor, 0);
  assert.strictEqual(
    context.processor.getMatchPieceSequence("match-recovery"),
    originalSequence
  );
});

test("finish prunes records and stale queued starts cannot recreate them", async (t) => {
  const context = fixture();
  t.after(() => context.processor.dispose());
  const firstCountdown = await readyBoth(context, "first", 2_000);
  enqueue(context, {
    type: "timer.countdown_elapsed",
    countdownId: firstCountdown.countdownId,
    matchId: "match-first",
    atMs: firstCountdown.startsAtMs
  });
  await waitUntil(() => context.processor.pendingCount === 0);
  assert.equal(context.processor.matchCount, 1);

  enqueue(context, {
    type: "match.finished",
    matchId: "match-first",
    winnerPlayerId: context.host.session.playerId,
    reason: "topout",
    serverFrame: 500,
    atMs: firstCountdown.startsAtMs + 100
  });
  assert.equal(context.processor.matchCount, 0);
  assert.equal(
    context.processor.getMatchPieceSequence("match-first"),
    null
  );
  await waitUntil(() => context.processor.pendingCount === 0);

  const secondCountdown = await readyBoth(
    context,
    "second",
    firstCountdown.startsAtMs + 200
  );
  context.hostTransport.clear();
  context.guestTransport.clear();
  enqueue(context, {
    type: "timer.countdown_elapsed",
    countdownId: secondCountdown.countdownId,
    matchId: "match-stale",
    atMs: secondCountdown.startsAtMs
  });
  enqueue(context, {
    type: "match.finished",
    matchId: "match-stale",
    winnerPlayerId: context.host.session.playerId,
    reason: "topout",
    serverFrame: 600,
    atMs: secondCountdown.startsAtMs + 1
  });
  await waitUntil(() => context.processor.pendingCount === 0);

  assert.equal(context.processor.matchCount, 0);
  assert.equal(
    context.processor.getMatchPieceSequence("match-stale"),
    null
  );
  assert.equal(messages(context.hostTransport, "match.start").length, 0);
  assert.equal(messages(context.guestTransport, "match.start").length, 0);
});
