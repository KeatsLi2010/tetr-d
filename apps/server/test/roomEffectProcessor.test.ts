import assert from "node:assert/strict";
import test from "node:test";
import type { RoomCommand, RoomState } from "../../../packages/room-core/src/model.ts";
import { createRoom, transitionRoom } from "../../../packages/room-core/src/room.ts";
import type { ServerMessage } from "../../../packages/protocol/src/messages.ts";
import { SessionStore } from "../src/auth/sessionStore.ts";
import { ConnectionHub } from "../src/gateway/connectionHub.ts";
import type { ConnectionTransport } from "../src/gateway/connectionHub.ts";
import type { RoomCommitOutboxScheduler } from "../src/rooms/roomCommitOutbox.ts";
import { RoomEffectProcessor } from "../src/rooms/roomEffectProcessor.ts";
import type { RoomRuntimeCommit } from "../src/rooms/roomRuntime.ts";
class FakeTransport implements ConnectionTransport {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  send(payload: string): void {
    this.sent.push(payload);
  }
  close(): void {}
  clear(): void {
    this.sent.length = 0;
  }
}
class ManualRetryScheduler implements RoomCommitOutboxScheduler {
  readonly tasks = new Map<number, () => void>();
  #nextId = 1;
  schedule(_deadlineMs: number, callback: () => void): number {
    const id = this.#nextId++;
    this.tasks.set(id, callback);
    return id;
  }
  cancel(handle: unknown): void {
    this.tasks.delete(handle as number);
  }
  runNext(): void {
    const next = this.tasks.entries().next().value as
      | readonly [number, () => void]
      | undefined;
    if (next === undefined) throw new Error("No retry is scheduled.");
    this.tasks.delete(next[0]);
    next[1]();
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
  const transition = transitionRoom(state, command);
  assert.equal(transition.kind, "committed");
  if (transition.kind !== "committed") {
    throw new Error("Expected a committed room transition.");
  }
  return {
    state: transition.state,
    commit: {
      before: state,
      after: transition.state,
      effects: transition.effects
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
  readonly host: ReturnType<SessionStore["createGuest"]>["session"];
  readonly guest: ReturnType<SessionStore["createGuest"]>["session"];
  readonly watcher: ReturnType<SessionStore["createGuest"]>["session"];
  readonly transports: readonly [FakeTransport, FakeTransport, FakeTransport];
  readonly retry: ManualRetryScheduler;
  removeCalls: number;
  failRemoveOnce: boolean;
  removed: boolean;
}
function fixture(): Fixture {
  let sessionNumber = 0;
  let playerNumber = 0;
  const sessions = new SessionStore({
    hmacKey: Buffer.alloc(32, 4),
    now: () => 1_000,
    sessionIdFactory: () => `session-${++sessionNumber}`,
    playerIdFactory: () => `player-${++playerNumber}`
  });
  const host = sessions.createGuest({
    displayName: "Host",
    connectionId: "connection-host"
  }).session;
  const guest = sessions.createGuest({
    displayName: "Guest",
    connectionId: "connection-guest"
  }).session;
  const watcher = sessions.createGuest({
    displayName: "Watcher",
    connectionId: "connection-watcher"
  }).session;
  let state = createRoom({
    roomId: "effect-room",
    roomCode: "EFF234",
    creator: host,
    connectionId: host.activeConnectionId!,
    nowMs: 1_000,
    settings: { allowSpectators: true }
  });
  state = apply(state, {
    type: "member.join",
    requestId: "join-guest",
    player: guest,
    connectionId: guest.activeConnectionId!,
    participation: "player",
    atMs: 1_100
  }).state;
  state = apply(state, {
    type: "member.join",
    requestId: "join-watcher",
    player: watcher,
    connectionId: watcher.activeConnectionId!,
    participation: "spectator",
    atMs: 1_200
  }).state;
  const hub = new ConnectionHub();
  const transports = [
    new FakeTransport(),
    new FakeTransport(),
    new FakeTransport()
  ] as const;
  for (const [index, session] of [host, guest, watcher].entries()) {
    sessions.bindRoom(session.sessionId, state.roomId);
    hub.bind({
      sessionId: session.sessionId,
      connectionId: session.activeConnectionId!,
      connectionGeneration: session.connectionGeneration,
      roomId: state.roomId,
      transport: transports[index]!
    });
  }
  const retry = new ManualRetryScheduler();
  const context = {
    state,
    sessions,
    hub,
    host,
    guest,
    watcher,
    transports,
    retry,
    removeCalls: 0,
    failRemoveOnce: false,
    removed: false
  } as Fixture;
  context.processor = new RoomEffectProcessor({
    sessions,
    connections: hub,
    getRoomState: () => (context.removed ? null : context.state),
    removeRoom: () => {
      context.removeCalls += 1;
      if (context.failRemoveOnce && context.removeCalls === 1) {
        throw new Error("temporary remove failure");
      }
      context.removed = true;
      return true;
    },
    outbox: {
      scheduler: retry,
      clock: () => 1_000,
      baseRetryMs: 10,
      maxRetryMs: 10
    }
  });
  return context;
}
function enqueue(
  context: Fixture,
  command: RoomCommand
): RoomRuntimeCommit {
  const result = apply(context.state, command);
  context.state = result.state;
  context.processor.enqueue(result.commit);
  return result.commit;
}
function clearTransports(context: Fixture): void {
  for (const transport of context.transports) transport.clear();
}
async function startMatch(context: Fixture): Promise<RoomRuntimeCommit> {
  enqueue(context, {
    type: "ready.set",
    requestId: "ready-host",
    actorPlayerId: context.host.playerId,
    expectedRevision: context.state.revision,
    ready: true,
    atMs: 2_000
  });
  await waitUntil(() => context.processor.pendingCount === 0);
  clearTransports(context);
  enqueue(context, {
    type: "ready.set",
    requestId: "ready-guest",
    actorPlayerId: context.guest.playerId,
    expectedRevision: context.state.revision,
    ready: true,
    atMs: 2_100
  });
  await waitUntil(() => context.processor.pendingCount === 0);
  const countdown = context.state.countdown!;
  clearTransports(context);
  const commit = enqueue(context, {
    type: "timer.countdown_elapsed",
    countdownId: countdown.countdownId,
    matchId: "match-effects",
    atMs: countdown.startsAtMs
  });
  await waitUntil(() => context.processor.pendingCount === 0);
  return commit;
}
test("room.state is projected separately for every viewer", async () => {
  const context = fixture();
  enqueue(context, {
    type: "settings.update",
    requestId: "settings",
    actorPlayerId: context.host.playerId,
    expectedRevision: context.state.revision,
    patch: { targetWins: 5 },
    atMs: 1_500
  });
  await waitUntil(() => context.processor.pendingCount === 0);
  const host = messages(context.transports[0], "room.state").at(-1)!;
  const guest = messages(context.transports[1], "room.state").at(-1)!;
  const watcher = messages(context.transports[2], "room.state").at(-1)!;
  assert.equal(host.state.self.playerId, context.host.playerId);
  assert.equal(host.state.self.permissions.editSettings, true);
  assert.equal(guest.state.self.playerId, context.guest.playerId);
  assert.equal(guest.state.self.permissions.editSettings, false);
  assert.equal(watcher.state.self.participation, "spectator");
});
test("countdown and match start share one committed finite piece window", async () => {
  const context = fixture();
  const startCommit = await startMatch(context);
  assert.equal(context.processor.enqueue(startCommit), false);
  const starts = context.transports.map(
    (transport) => messages(transport, "match.start")[0]!
  );
  const [hostStart, guestStart, watcherStart] = starts;
  assert.ok(hostStart && guestStart && watcherStart);
  assert.equal(context.processor.matchCount, 1);
  assert.equal(
    new Set(starts.map((message) => message.pieceSequenceCommitment)).size,
    1
  );
  assert.equal(hostStart.selfPieceCursor, 0);
  assert.equal(guestStart.selfPieceCursor, 0);
  assert.deepEqual(hostStart.selfPieceWindow, guestStart.selfPieceWindow);
  assert.equal(hostStart.selfPieceWindow.length, 14);
  assert.equal(watcherStart.selfPieceCursor, null);
  assert.deepEqual(watcherStart.selfPieceWindow, []);
  assert.equal(
    context.processor.getMatchPieceSequence("match-effects")?.getCursor(
      context.host.playerId
    ),
    1
  );
});
test("disconnect presence and kicked membership are routed and cleared", async () => {
  const context = fixture();
  await startMatch(context);
  clearTransports(context);
  const member = context.state.members[context.guest.playerId]!;
  assert.equal(member.connection.kind, "connected");
  if (member.connection.kind !== "connected") return;
  enqueue(context, {
    type: "connection.lost",
    playerId: context.guest.playerId,
    connectionId: member.connection.connectionId,
    expectedConnectionEpoch: member.connection.epoch,
    atMs: 6_000
  });
  await waitUntil(() => context.processor.pendingCount === 0);
  const presence = messages(
    context.transports[0],
    "match.presence"
  )[0]!;
  assert.equal(presence.playerId, context.guest.playerId);
  assert.equal(presence.connected, false);
  clearTransports(context);
  enqueue(context, {
    type: "member.kick",
    requestId: "kick-watcher",
    actorPlayerId: context.host.playerId,
    targetPlayerId: context.watcher.playerId,
    expectedRevision: context.state.revision,
    atMs: 6_100
  });
  await waitUntil(() => context.processor.pendingCount === 0);
  assert.equal(
    messages(context.transports[2], "room.removed")[0]?.reason,
    "kicked"
  );
  assert.equal(
    context.sessions.getBySessionId(context.watcher.sessionId)?.roomId,
    null
  );
  assert.equal(context.hub.roomSize(context.state.roomId), 2);
});
test("reconnect expiry sends timeout removal and clears bindings", async () => {
  const context = fixture();
  const watcher = context.state.members[context.watcher.playerId]!;
  assert.equal(watcher.connection.kind, "connected");
  if (watcher.connection.kind !== "connected") return;
  enqueue(context, {
    type: "connection.lost",
    playerId: context.watcher.playerId,
    connectionId: watcher.connection.connectionId,
    expectedConnectionEpoch: watcher.connection.epoch,
    atMs: 2_000
  });
  await waitUntil(() => context.processor.pendingCount === 0);
  clearTransports(context);
  const disconnected = context.state.members[context.watcher.playerId]!;
  assert.equal(disconnected.connection.kind, "disconnected");
  if (disconnected.connection.kind !== "disconnected") return;
  enqueue(context, {
    type: "timer.reconnect_elapsed",
    playerId: context.watcher.playerId,
    expectedConnectionEpoch: disconnected.connection.epoch,
    atMs: disconnected.connection.reconnectDeadlineMs
  });
  await waitUntil(() => context.processor.pendingCount === 0);
  assert.equal(
    messages(context.transports[2], "room.removed")[0]?.reason,
    "reconnect_timeout"
  );
  assert.equal(
    context.sessions.getBySessionId(context.watcher.sessionId)?.roomId,
    null
  );
});
test("room close retries removal without duplicating client side effects", async () => {
  const context = fixture();
  context.failRemoveOnce = true;
  enqueue(context, {
    type: "room.close",
    requestId: "close-room",
    actorPlayerId: context.host.playerId,
    expectedRevision: context.state.revision,
    atMs: 2_000
  });
  await waitUntil(() => context.retry.tasks.size === 1);
  assert.equal(context.removeCalls, 1);
  context.retry.runNext();
  await waitUntil(() => context.processor.pendingCount === 0);
  assert.equal(context.removeCalls, 2);
  assert.equal(context.removed, true);
  for (const transport of context.transports) {
    assert.equal(messages(transport, "room.closed").length, 1);
  }
  for (const session of [context.host, context.guest, context.watcher]) {
    assert.equal(
      context.sessions.getBySessionId(session.sessionId)?.roomId,
      null
    );
  }
  assert.equal(context.hub.roomSize(context.state.roomId), 0);
});
