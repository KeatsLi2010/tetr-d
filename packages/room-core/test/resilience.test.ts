import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ROOM_POLICY,
  GUEST,
  HOST,
  WATCHER,
  apply,
  committed,
  fresh,
  joinGuest,
  setReady,
  startMatch
} from "./helpers.ts";

test("lobby reconnect preserves seat and advances connection epoch", () => {
  let state = joinGuest(fresh());
  state = committed(state, {
    type: "connection.lost",
    playerId: GUEST.playerId,
    connectionId: "connection-guest",
    expectedConnectionEpoch: 0,
    atMs: 2_000
  });
  assert.equal(state.members[GUEST.playerId]!.connection.kind, "disconnected");
  state = committed(state, {
    type: "connection.resumed",
    playerId: GUEST.playerId,
    expectedConnectionEpoch: 0,
    newConnectionId: "connection-guest-2",
    atMs: 2_500
  });
  assert.equal(state.members[GUEST.playerId]!.connection.kind, "connected");
  assert.equal(state.members[GUEST.playerId]!.connection.epoch, 1);
  assert.equal(state.seats[1], GUEST.playerId);
});

test("lobby reconnect timeout removes the member with an explicit effect", () => {
  let state = joinGuest(fresh());
  state = committed(state, {
    type: "connection.lost",
    playerId: GUEST.playerId,
    connectionId: "connection-guest",
    expectedConnectionEpoch: 0,
    atMs: 2_000
  });
  const connection = state.members[GUEST.playerId]!.connection;
  assert.equal(connection.kind, "disconnected");
  if (connection.kind !== "disconnected") return;

  const timedOut = apply(state, {
    type: "timer.reconnect_elapsed",
    playerId: GUEST.playerId,
    expectedConnectionEpoch: 0,
    atMs: connection.reconnectDeadlineMs
  });

  assert.equal(timedOut.kind, "committed");
  if (timedOut.kind !== "committed") return;
  assert.equal(timedOut.state.members[GUEST.playerId], undefined);
  assert.ok(timedOut.effects.some(
    (effect) =>
      effect.type === "member.reconnect_expired" &&
      effect.playerId === GUEST.playerId
  ));
});

test("late loss from an old connection epoch cannot disconnect a resumed socket", () => {
  let state = joinGuest(fresh());
  state = committed(state, {
    type: "connection.lost",
    playerId: GUEST.playerId,
    connectionId: "connection-guest",
    expectedConnectionEpoch: 0,
    atMs: 2_000
  });
  state = committed(state, {
    type: "connection.resumed",
    playerId: GUEST.playerId,
    expectedConnectionEpoch: 0,
    newConnectionId: "connection-guest",
    atMs: 2_100
  });
  const late = apply(state, {
    type: "connection.lost",
    playerId: GUEST.playerId,
    connectionId: "connection-guest",
    expectedConnectionEpoch: 0,
    atMs: 2_200
  });
  assert.equal(late.kind, "ignored");
  assert.equal(state.members[GUEST.playerId]!.connection.kind, "connected");
  assert.equal(state.members[GUEST.playerId]!.connection.epoch, 1);
});

test("connected takeover preserves countdown and invalidates the old socket", () => {
  let state = joinGuest(fresh());
  state = setReady(state, HOST.playerId, true, 2_000);
  state = setReady(state, GUEST.playerId, true, 2_100);
  const revision = state.revision;
  const replaced = apply(state, {
    type: "connection.replace",
    playerId: GUEST.playerId,
    expectedConnectionId: "connection-guest",
    expectedConnectionEpoch: 0,
    newConnectionId: "connection-guest-replaced",
    atMs: 2_200
  });
  assert.equal(replaced.kind, "committed");
  if (replaced.kind !== "committed") return;
  state = replaced.state;
  assert.equal(state.phase, "countdown");
  assert.deepEqual(state.ready, [true, true]);
  assert.equal(state.revision, revision);
  assert.equal(state.members[GUEST.playerId]!.connection.epoch, 1);

  const oldClose = apply(state, {
    type: "connection.lost",
    playerId: GUEST.playerId,
    connectionId: "connection-guest",
    expectedConnectionEpoch: 0,
    atMs: 2_300
  });
  assert.equal(oldClose.kind, "ignored");
});

test("connected takeover clears held input during a live match", () => {
  const state = startMatch(joinGuest(fresh()));
  const replaced = apply(state, {
    type: "connection.replace",
    playerId: GUEST.playerId,
    expectedConnectionId: "connection-guest",
    expectedConnectionEpoch: 0,
    newConnectionId: "connection-guest-live",
    atMs: 6_000
  });
  assert.equal(replaced.kind, "committed");
  if (replaced.kind !== "committed") return;
  assert.ok(
    replaced.effects.some(
      (effect) =>
        effect.type === "match.clear_input" &&
        effect.playerId === GUEST.playerId
    )
  );
});

test("in-match disconnect grants 15 seconds then requests server forfeit", () => {
  let state = startMatch(joinGuest(fresh()));
  state = committed(state, {
    type: "connection.lost",
    playerId: GUEST.playerId,
    connectionId: "connection-guest",
    expectedConnectionEpoch: 0,
    atMs: 6_000
  });
  const connection = state.members[GUEST.playerId]!.connection;
  assert.equal(connection.kind, "disconnected");
  if (connection.kind !== "disconnected") return;
  assert.equal(
    connection.reconnectDeadlineMs,
    6_000 + DEFAULT_ROOM_POLICY.matchReconnectGraceMs
  );

  const timedOut = apply(state, {
    type: "timer.reconnect_elapsed",
    playerId: GUEST.playerId,
    expectedConnectionEpoch: 0,
    atMs: connection.reconnectDeadlineMs
  });
  assert.equal(timedOut.kind, "committed");
  if (timedOut.kind !== "committed") return;
  assert.ok(
    timedOut.effects.some(
      (effect) =>
        effect.type === "match.disconnect_forfeit" &&
        effect.winnerPlayerId === HOST.playerId
    )
  );
  const resume = apply(timedOut.state, {
    type: "connection.resumed",
    playerId: GUEST.playerId,
    expectedConnectionEpoch: 0,
    newConnectionId: "too-late",
    atMs: connection.reconnectDeadlineMs + 1
  });
  assert.equal(resume.kind, "rejected");
  if (resume.kind === "rejected") assert.equal(resume.code, "RESUME_EXPIRED");
});

test("two disconnect timers can request at most one match resolution", () => {
  let state = startMatch(joinGuest(fresh()));
  state = committed(state, {
    type: "connection.lost",
    playerId: GUEST.playerId,
    connectionId: "connection-guest",
    expectedConnectionEpoch: 0,
    atMs: 6_000
  });
  state = committed(state, {
    type: "connection.lost",
    playerId: HOST.playerId,
    connectionId: "connection-host",
    expectedConnectionEpoch: 0,
    atMs: 6_001
  });
  const guestConnection = state.members[GUEST.playerId]!.connection;
  const hostConnection = state.members[HOST.playerId]!.connection;
  assert.equal(guestConnection.kind, "disconnected");
  assert.equal(hostConnection.kind, "disconnected");
  if (
    guestConnection.kind !== "disconnected" ||
    hostConnection.kind !== "disconnected"
  ) {
    return;
  }
  const first = apply(state, {
    type: "timer.reconnect_elapsed",
    playerId: GUEST.playerId,
    expectedConnectionEpoch: 0,
    atMs: guestConnection.reconnectDeadlineMs
  });
  assert.equal(first.kind, "committed");
  if (first.kind !== "committed") return;
  const second = apply(first.state, {
    type: "timer.reconnect_elapsed",
    playerId: HOST.playerId,
    expectedConnectionEpoch: 0,
    atMs: hostConnection.reconnectDeadlineMs
  });
  assert.equal(second.kind, "ignored");
  const resolutionEffects = first.effects.filter(
    (effect) => effect.type === "match.disconnect_forfeit"
  );
  assert.equal(resolutionEffects.length, 1);
});

test("match result reason and winner must form a valid server verdict", () => {
  const state = startMatch(joinGuest(fresh()));
  const invalid = apply(state, {
    type: "match.finished",
    matchId: state.activeMatch!.matchId,
    winnerPlayerId: HOST.playerId,
    reason: "draw",
    serverFrame: 100,
    atMs: 6_000
  });
  assert.equal(invalid.kind, "rejected");
  if (invalid.kind === "rejected") {
    assert.equal(invalid.code, "INVALID_COMMAND");
  }
  assert.equal(state.phase, "playing");
});

test("room timers close idle rooms and enforce the six-hour hard cap", () => {
  const lobby = fresh();
  const early = apply(lobby, {
    type: "timer.room_expired",
    atMs: lobby.expiresAtMs - 1
  });
  assert.equal(early.kind, "ignored");
  const expired = apply(lobby, {
    type: "timer.room_expired",
    atMs: lobby.expiresAtMs
  });
  assert.equal(expired.kind, "committed");
  if (expired.kind === "committed") {
    assert.equal(expired.state.phase, "closed");
    assert.equal(expired.state.closedReason, "expired");
  }

  const playing = startMatch(joinGuest(fresh()));
  const liveExpiry = apply(playing, {
    type: "timer.room_expired",
    atMs: playing.expiresAtMs + 1
  });
  assert.equal(liveExpiry.kind, "committed");
  if (liveExpiry.kind === "committed") {
    assert.equal(liveExpiry.state.phase, "closed");
  }
});

test("a room command arriving at an elapsed idle deadline closes the room", () => {
  const state = fresh();
  const result = apply(state, {
    type: "ready.set",
    requestId: "ready-after-expiry",
    actorPlayerId: HOST.playerId,
    expectedRevision: state.revision,
    ready: true,
    atMs: state.expiresAtMs
  });
  assert.equal(result.kind, "committed");
  if (result.kind === "committed") {
    assert.equal(result.state.phase, "closed");
    assert.equal(result.state.closedReason, "expired");
  }
});

test("only host can close and active series cannot be closed", () => {
  let state = joinGuest(fresh());
  const nonHost = apply(state, {
    type: "room.close",
    requestId: "close-non-host",
    actorPlayerId: GUEST.playerId,
    expectedRevision: state.revision,
    atMs: 2_000
  });
  assert.equal(nonHost.kind, "rejected");
  if (nonHost.kind === "rejected") assert.equal(nonHost.code, "NOT_HOST");

  state = startMatch(state);
  const live = apply(state, {
    type: "room.close",
    requestId: "close-live",
    actorPlayerId: HOST.playerId,
    expectedRevision: state.revision,
    atMs: 6_000
  });
  assert.equal(live.kind, "rejected");
  if (live.kind === "rejected") assert.equal(live.code, "ACTIVE_MATCH");
});

test("new client commands against a closed room return ROOM_CLOSED", () => {
  let state = fresh();
  state = committed(state, {
    type: "room.close",
    requestId: "close-room",
    actorPlayerId: HOST.playerId,
    expectedRevision: state.revision,
    atMs: 2_000
  });
  const result = apply(state, {
    type: "settings.update",
    requestId: "edit-closed-room",
    actorPlayerId: HOST.playerId,
    expectedRevision: state.revision,
    patch: { targetWins: 5 },
    atMs: 2_100
  });
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") assert.equal(result.code, "ROOM_CLOSED");
});
