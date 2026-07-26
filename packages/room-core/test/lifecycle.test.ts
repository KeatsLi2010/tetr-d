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

test("creation occupies one of two seats and uses conservative defaults", () => {
  const state = fresh();

  assert.equal(state.revision, 1);
  assert.equal(state.phase, "lobby");
  assert.deepEqual(state.seats, [HOST.playerId, null]);
  assert.equal(state.hostPlayerId, HOST.playerId);
  assert.deepEqual(state.settings, {
    targetWins: 3,
    allowSpectators: false
  });
  assert.equal(state.expiresAtMs, 1_000 + DEFAULT_ROOM_POLICY.lobbyIdleTtlMs);
});

test("two player seats are fixed and spectators are opt-in", () => {
  let state = joinGuest(fresh());
  const full = apply(state, {
    type: "member.join",
    requestId: "join-third",
    player: { playerId: "third", displayName: "Third" },
    connectionId: "connection-third",
    participation: "player",
    atMs: 1_200
  });
  assert.equal(full.kind, "rejected");
  if (full.kind === "rejected") assert.equal(full.code, "ROOM_FULL");

  const disabled = apply(state, {
    type: "member.join",
    requestId: "watch-disabled",
    player: WATCHER,
    connectionId: "connection-watcher",
    participation: "spectator",
    atMs: 1_300
  });
  assert.equal(disabled.kind, "rejected");
  if (disabled.kind === "rejected") {
    assert.equal(disabled.code, "SPECTATING_DISABLED");
  }
});

test("host can enable capped spectators without creating a third player", () => {
  let state = fresh();
  state = committed(state, {
    type: "settings.update",
    requestId: "enable-watch",
    actorPlayerId: HOST.playerId,
    expectedRevision: state.revision,
    patch: { allowSpectators: true },
    atMs: 1_100
  });
  for (let index = 0; index < DEFAULT_ROOM_POLICY.maxSpectators; index += 1) {
    state = committed(state, {
      type: "member.join",
      requestId: `join-watch-${index}`,
      player: { playerId: `watch-${index}`, displayName: `Watch ${index}` },
      connectionId: `connection-watch-${index}`,
      participation: "spectator",
      atMs: 1_200 + index
    });
  }
  assert.deepEqual(state.seats, [HOST.playerId, null]);
  const overflow = apply(state, {
    type: "member.join",
    requestId: "watch-overflow",
    player: { playerId: "watch-overflow", displayName: "Overflow" },
    connectionId: "connection-overflow",
    participation: "spectator",
    atMs: 1_300
  });
  assert.equal(overflow.kind, "rejected");
  if (overflow.kind === "rejected") {
    assert.equal(overflow.code, "SPECTATOR_LIMIT");
  }
});

test("stale revisions are rejected before mutating room state", () => {
  const state = fresh();
  const result = apply(state, {
    type: "settings.update",
    requestId: "stale",
    actorPlayerId: HOST.playerId,
    expectedRevision: 0,
    patch: { targetWins: 5 },
    atMs: 1_100
  });

  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.equal(result.code, "REVISION_CONFLICT");
    assert.equal(result.currentRevision, 1);
    assert.strictEqual(result.state, state);
  }
});

test("both ready starts an automatic three-second countdown", () => {
  let state = joinGuest(fresh());
  state = setReady(state, HOST.playerId, true, 2_000);
  const before = JSON.stringify(state);
  const result = apply(state, {
    type: "ready.set",
    requestId: "guest-ready",
    actorPlayerId: GUEST.playerId,
    expectedRevision: state.revision,
    ready: true,
    atMs: 2_100
  });

  assert.equal(JSON.stringify(state), before, "input state must remain immutable");
  assert.equal(result.kind, "committed");
  if (result.kind !== "committed") return;
  assert.equal(result.state.phase, "countdown");
  assert.equal(result.state.rulesStatus, "locked");
  assert.equal(result.state.countdown?.startsAtMs, 5_100);
  assert.deepEqual(result.state.series?.wins, [0, 0]);
  assert.ok(result.effects.some((effect) => effect.type === "countdown.schedule"));
});

test("unready or disconnect cancels countdown and clears both ready flags", () => {
  let state = joinGuest(fresh());
  state = setReady(state, HOST.playerId, true, 2_000);
  state = setReady(state, GUEST.playerId, true, 2_100);
  state = setReady(state, HOST.playerId, false, 2_200);
  assert.equal(state.phase, "lobby");
  assert.deepEqual(state.ready, [false, false]);
  assert.equal(state.series, null);

  state = setReady(state, HOST.playerId, true, 2_300);
  state = setReady(state, GUEST.playerId, true, 2_400);
  const lost = apply(state, {
    type: "connection.lost",
    playerId: GUEST.playerId,
    connectionId: "connection-guest",
    expectedConnectionEpoch: 0,
    atMs: 2_500
  });
  assert.equal(lost.kind, "committed");
  if (lost.kind !== "committed") return;
  assert.equal(lost.state.phase, "lobby");
  assert.deepEqual(lost.state.ready, [false, false]);
  assert.ok(lost.effects.some((effect) => effect.type === "countdown.cancel"));
});

test("spectator disconnect cannot cancel the players' countdown", () => {
  let state = fresh({ settings: { allowSpectators: true } });
  state = joinGuest(state);
  state = committed(state, {
    type: "member.join",
    requestId: "watch-join",
    player: WATCHER,
    connectionId: "connection-watcher",
    participation: "spectator",
    atMs: 1_200
  });
  state = setReady(state, HOST.playerId, true, 2_000);
  state = setReady(state, GUEST.playerId, true, 2_100);
  state = committed(state, {
    type: "connection.lost",
    playerId: WATCHER.playerId,
    connectionId: "connection-watcher",
    expectedConnectionEpoch: 0,
    atMs: 2_200
  });

  assert.equal(state.phase, "countdown");
  assert.deepEqual(state.ready, [true, true]);
  assert.ok(state.countdown);
});

test("spectator presence changes do not invalidate player control revisions", () => {
  let state = fresh({ settings: { allowSpectators: true } });
  state = joinGuest(state);
  state = committed(state, {
    type: "member.join",
    requestId: "presence-watch-join",
    player: WATCHER,
    connectionId: "presence-watch-connection",
    participation: "spectator",
    atMs: 1_200
  });
  const controlRevision = state.revision;
  const presenceSequence = state.presenceSequence;
  state = committed(state, {
    type: "connection.lost",
    playerId: WATCHER.playerId,
    connectionId: "presence-watch-connection",
    expectedConnectionEpoch: 0,
    atMs: 1_300
  });
  assert.equal(state.revision, controlRevision);
  assert.equal(state.presenceSequence, presenceSequence + 1);

  const ready = apply(state, {
    type: "ready.set",
    requestId: "ready-after-presence",
    actorPlayerId: HOST.playerId,
    expectedRevision: controlRevision,
    ready: true,
    atMs: 1_400
  });
  assert.equal(ready.kind, "committed");
});

test("countdown timer starts exactly one match and stale timers are ignored", () => {
  let state = joinGuest(fresh());
  state = setReady(state, HOST.playerId, true, 1_800);
  state = setReady(state, GUEST.playerId, true, 2_000);
  assert.ok(state.countdown);
  const early = apply(state, {
    type: "timer.countdown_elapsed",
    countdownId: state.countdown.countdownId,
    matchId: "match-early",
    atMs: 4_999
  });
  assert.equal(early.kind, "ignored");

  state = committed(state, {
    type: "timer.countdown_elapsed",
    countdownId: state.countdown.countdownId,
    matchId: "match-live",
    atMs: 5_000
  });
  assert.equal(state.phase, "playing");
  const duplicate = apply(state, {
    type: "timer.countdown_elapsed",
    countdownId: 1,
    matchId: "match-duplicate",
    atMs: 5_001
  });
  assert.equal(duplicate.kind, "ignored");
});

test("unfinished games preserve locked series score between rounds", () => {
  let state = joinGuest(
    fresh({ settings: { targetWins: 2, allowSpectators: false } })
  );
  state = startMatch(state);
  const seriesId = state.series?.seriesId;
  state = committed(state, {
    type: "match.finished",
    matchId: state.activeMatch!.matchId,
    winnerPlayerId: HOST.playerId,
    reason: "topout",
    serverFrame: 500,
    atMs: 6_000
  });
  assert.equal(state.phase, "between_games");
  assert.equal(state.rulesStatus, "locked");
  assert.deepEqual(state.series?.wins, [1, 0]);

  state = setReady(state, HOST.playerId, true, 6_100);
  state = setReady(state, GUEST.playerId, true, 6_200);
  assert.equal(state.series?.seriesId, seriesId);
  assert.equal(state.countdown?.gameNumber, 2);
});

test("draws advance the game number without awarding a series win", () => {
  let state = startMatch(joinGuest(fresh()));
  state = committed(state, {
    type: "match.finished",
    matchId: state.activeMatch!.matchId,
    winnerPlayerId: null,
    reason: "draw",
    serverFrame: 900,
    atMs: 6_000
  });
  assert.equal(state.phase, "between_games");
  assert.equal(state.series?.gamesPlayed, 1);
  assert.deepEqual(state.series?.wins, [0, 0]);
});

test("series completion requires mutual rematch consent", () => {
  let state = joinGuest(
    fresh({ settings: { targetWins: 1, allowSpectators: false } })
  );
  state = startMatch(state);
  const oldSeriesId = state.series!.seriesId;
  state = committed(state, {
    type: "match.finished",
    matchId: state.activeMatch!.matchId,
    winnerPlayerId: HOST.playerId,
    reason: "topout",
    serverFrame: 400,
    atMs: 6_000
  });
  assert.equal(state.phase, "series_complete");
  assert.equal(state.series?.winnerPlayerId, HOST.playerId);

  state = committed(state, {
    type: "series.rematch",
    requestId: "rematch-host",
    actorPlayerId: HOST.playerId,
    expectedRevision: state.revision,
    accepted: true,
    atMs: 6_100
  });
  assert.equal(state.phase, "series_complete");
  state = committed(state, {
    type: "series.rematch",
    requestId: "rematch-guest",
    actorPlayerId: GUEST.playerId,
    expectedRevision: state.revision,
    accepted: true,
    atMs: 6_200
  });
  assert.equal(state.phase, "countdown");
  assert.notEqual(state.series?.seriesId, oldSeriesId);
  assert.deepEqual(state.ready, [true, true]);
});

test("disconnect clears that player's rematch vote and cannot deadlock consent", () => {
  let state = joinGuest(
    fresh({ settings: { targetWins: 1, allowSpectators: false } })
  );
  state = startMatch(state);
  state = committed(state, {
    type: "match.finished",
    matchId: state.activeMatch!.matchId,
    winnerPlayerId: HOST.playerId,
    reason: "topout",
    serverFrame: 400,
    atMs: 6_000
  });
  state = committed(state, {
    type: "series.rematch",
    requestId: "host-votes-before-loss",
    actorPlayerId: HOST.playerId,
    expectedRevision: state.revision,
    accepted: true,
    atMs: 6_100
  });
  state = committed(state, {
    type: "connection.lost",
    playerId: HOST.playerId,
    connectionId: "connection-host",
    expectedConnectionEpoch: 0,
    atMs: 6_200
  });
  assert.deepEqual(state.rematchVotes, [false, false]);
  state = committed(state, {
    type: "series.rematch",
    requestId: "guest-votes-while-host-away",
    actorPlayerId: GUEST.playerId,
    expectedRevision: state.revision,
    accepted: true,
    atMs: 6_300
  });
  state = committed(state, {
    type: "connection.resumed",
    playerId: HOST.playerId,
    expectedConnectionEpoch: 0,
    newConnectionId: "connection-host-2",
    atMs: 6_400
  });
  state = committed(state, {
    type: "series.rematch",
    requestId: "host-votes-after-resume",
    actorPlayerId: HOST.playerId,
    expectedRevision: state.revision,
    accepted: true,
    atMs: 6_500
  });
  assert.equal(state.phase, "countdown");
});
