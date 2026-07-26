import assert from "node:assert/strict";
import test from "node:test";

import { MAX_DENIED_PLAYER_IDS } from "../src/index.ts";
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

test("rules and active opponent are protected for an unfinished series", () => {
  let state = startMatch(joinGuest(fresh()));
  state = committed(state, {
    type: "match.finished",
    matchId: state.activeMatch!.matchId,
    winnerPlayerId: HOST.playerId,
    reason: "topout",
    serverFrame: 300,
    atMs: 6_000
  });
  const settings = apply(state, {
    type: "settings.update",
    requestId: "edit-locked",
    actorPlayerId: HOST.playerId,
    expectedRevision: state.revision,
    patch: { targetWins: 5 },
    atMs: 6_100
  });
  assert.equal(settings.kind, "rejected");
  if (settings.kind === "rejected") assert.equal(settings.code, "RULES_LOCKED");

  const kick = apply(state, {
    type: "member.kick",
    requestId: "kick-active-opponent",
    actorPlayerId: HOST.playerId,
    expectedRevision: state.revision,
    targetPlayerId: GUEST.playerId,
    atMs: 6_200
  });
  assert.equal(kick.kind, "rejected");
  if (kick.kind === "rejected") {
    assert.equal(kick.code, "CANNOT_KICK_ACTIVE_PLAYER");
  }
});

test("host authority is independent from seats and transfers deterministically", () => {
  let state = fresh({ settings: { allowSpectators: true } });
  state = joinGuest(state);
  state = committed(state, {
    type: "member.join",
    requestId: "join-watcher",
    player: WATCHER,
    connectionId: "connection-watcher",
    participation: "spectator",
    atMs: 1_200
  });
  state = committed(state, {
    type: "host.transfer",
    requestId: "host-to-watcher",
    actorPlayerId: HOST.playerId,
    expectedRevision: state.revision,
    targetPlayerId: WATCHER.playerId,
    atMs: 1_300
  });
  assert.equal(state.hostPlayerId, WATCHER.playerId);
  assert.equal(state.seats.includes(WATCHER.playerId), false);

  state = committed(state, {
    type: "member.leave",
    requestId: "watcher-leaves",
    actorPlayerId: WATCHER.playerId,
    expectedRevision: state.revision,
    atMs: 1_400
  });
  assert.equal(state.hostPlayerId, HOST.playerId);
});

test("host remains empty when only disconnected members remain, then recovers", () => {
  let state = joinGuest(fresh());
  state = committed(state, {
    type: "connection.lost",
    playerId: GUEST.playerId,
    connectionId: "connection-guest",
    expectedConnectionEpoch: 0,
    atMs: 1_200
  });
  state = committed(state, {
    type: "member.leave",
    requestId: "host-leaves-disconnected-guest",
    actorPlayerId: HOST.playerId,
    expectedRevision: state.revision,
    atMs: 1_300
  });
  assert.equal(state.hostPlayerId, null);
  state = committed(state, {
    type: "connection.resumed",
    playerId: GUEST.playerId,
    expectedConnectionEpoch: 0,
    newConnectionId: "connection-guest-2",
    atMs: 1_400
  });
  assert.equal(state.hostPlayerId, GUEST.playerId);
});

test("kicked members cannot reuse the same player identity to rejoin", () => {
  let state = joinGuest(fresh());
  state = committed(state, {
    type: "member.kick",
    requestId: "kick-guest",
    actorPlayerId: HOST.playerId,
    expectedRevision: state.revision,
    targetPlayerId: GUEST.playerId,
    atMs: 1_200
  });
  const retry = apply(state, {
    type: "member.join",
    requestId: "guest-retry",
    player: GUEST,
    connectionId: "connection-guest-new",
    participation: "player",
    atMs: 1_300
  });
  assert.equal(retry.kind, "rejected");
  if (retry.kind === "rejected") assert.equal(retry.code, "ROOM_KICKED");
});

test("object prototype keys never resolve as room members", () => {
  const state = fresh();
  for (const targetPlayerId of ["__proto__", "constructor", "toString"]) {
    const result = apply(state, {
      type: "member.kick",
      requestId: `kick-${targetPlayerId}`,
      actorPlayerId: HOST.playerId,
      expectedRevision: state.revision,
      targetPlayerId,
      atMs: 1_200
    });
    assert.equal(result.kind, "rejected");
    if (result.kind === "rejected") {
      assert.equal(result.code, "TARGET_NOT_MEMBER");
    }
  }
});

test("kick denylist has a fixed memory bound", () => {
  let state = fresh({ settings: { allowSpectators: true } });
  for (let index = 0; index <= MAX_DENIED_PLAYER_IDS; index += 1) {
    const playerId = `kicked-${index}`;
    state = committed(state, {
      type: "member.join",
      requestId: `join-${playerId}`,
      player: { playerId, displayName: `Player ${index}` },
      connectionId: `connection-${playerId}`,
      participation: "spectator",
      atMs: 2_000 + index * 2
    });
    state = committed(state, {
      type: "member.kick",
      requestId: `kick-${playerId}`,
      actorPlayerId: HOST.playerId,
      expectedRevision: state.revision,
      targetPlayerId: playerId,
      atMs: 2_001 + index * 2
    });
  }

  assert.equal(state.deniedPlayerIds.length, MAX_DENIED_PLAYER_IDS);
  assert.equal(state.deniedPlayerIds.includes("kicked-0"), false);
  assert.equal(
    state.deniedPlayerIds.includes(`kicked-${MAX_DENIED_PLAYER_IDS}`),
    true
  );
});
