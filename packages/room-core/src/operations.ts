import { MAX_DENIED_PLAYER_IDS } from "./model.ts";
import type {
  RoomEffect,
  RoomErrorCode,
  RoomMember,
  RoomPolicy,
  RoomSeries,
  RoomState,
  RoomTransition
} from "./model.ts";
import { assertRoomInvariants } from "./invariants.ts";
import {
  chooseHost,
  connected,
  ownMember,
  rosterOf,
  seatOf,
  withoutMember
} from "./validation.ts";

export function expiryFor(
  state: RoomState,
  nowMs: number,
  policy: RoomPolicy
): number {
  if (state.phase === "closed") return nowMs;
  const hasConnectedMember = Object.values(state.members).some(connected);
  let ttl = policy.lobbyIdleTtlMs;
  if (!hasConnectedMember) ttl = policy.emptyTtlMs;
  else if (state.phase === "series_complete") ttl = policy.seriesCompleteTtlMs;
  else if (state.phase === "playing") return state.absoluteExpiresAtMs;
  return Math.min(state.absoluteExpiresAtMs, nowMs + ttl);
}

export function commit(
  previous: RoomState,
  proposed: RoomState,
  atMs: number,
  effects: readonly RoomEffect[],
  policy: RoomPolicy,
  controlRevision = true
): RoomTransition {
  const effectiveNow = Math.max(previous.updatedAtMs, atMs);
  const revision = previous.revision + (controlRevision ? 1 : 0);
  const presenceSequence = previous.presenceSequence + 1;
  const withRevision: RoomState = {
    ...proposed,
    revision,
    presenceSequence,
    updatedAtMs: effectiveNow,
    expiresAtMs: expiryFor(proposed, effectiveNow, policy)
  };
  assertRoomInvariants(withRevision);
  return {
    kind: "committed",
    state: withRevision,
    effects: [
      ...effects,
      { type: "room.state_changed", revision, presenceSequence }
    ]
  };
}

export function reject(state: RoomState, code: RoomErrorCode): RoomTransition {
  return {
    kind: "rejected",
    state,
    code,
    currentRevision: state.revision
  };
}

export function ignore(
  state: RoomState,
  reason: "stale_connection" | "stale_timer" | "stale_match"
): RoomTransition {
  return { kind: "ignored", state, reason };
}

export function versionError(
  state: RoomState,
  expectedRevision: number
): RoomTransition | null {
  return expectedRevision === state.revision
    ? null
    : reject(state, "REVISION_CONFLICT");
}

export function actorError(
  state: RoomState,
  actorPlayerId: string
): RoomTransition | null {
  const member = ownMember(state.members, actorPlayerId);
  if (!member) return reject(state, "NOT_IN_ROOM");
  if (!connected(member)) return reject(state, "NOT_CONNECTED");
  return null;
}

export function hostError(
  state: RoomState,
  actorPlayerId: string
): RoomTransition | null {
  const membershipError = actorError(state, actorPlayerId);
  if (membershipError) return membershipError;
  return state.hostPlayerId === actorPlayerId
    ? null
    : reject(state, "NOT_HOST");
}

export function countdownCancelEffect(
  state: RoomState,
  reason: "unready" | "disconnect" | "roster_changed"
): readonly RoomEffect[] {
  return state.countdown === null
    ? []
    : [
        {
          type: "countdown.cancel",
          countdownId: state.countdown.countdownId,
          reason
        }
      ];
}

export function resetCompetition(state: RoomState): RoomState {
  return {
    ...state,
    phase: "lobby",
    ready: [false, false],
    rematchVotes: [false, false],
    rulesStatus: "draft",
    countdown: null,
    series: null,
    activeMatch: null
  };
}

export function cancelCountdown(
  state: RoomState,
  reason: "unready" | "disconnect" | "roster_changed"
): { readonly state: RoomState; readonly effects: readonly RoomEffect[] } {
  const effects = countdownCancelEffect(state, reason);
  const returnBetweenGames =
    state.countdown?.origin === "between_games" &&
    state.series !== null &&
    !state.series.completed;
  return {
    state: {
      ...state,
      phase: returnBetweenGames ? "between_games" : "lobby",
      ready: [false, false],
      rematchVotes: [false, false],
      rulesStatus: returnBetweenGames ? "locked" : "draft",
      countdown: null,
      series: returnBetweenGames ? state.series : null,
      activeMatch: null
    },
    effects
  };
}

export function createSeries(state: RoomState): RoomSeries {
  const roster = rosterOf(state);
  if (roster === null) {
    throw new Error("Cannot create a series without two occupied seats.");
  }
  return {
    seriesId: `${state.roomId}:series:${state.nextSeriesNumber}`,
    roster,
    targetWins: state.settings.targetWins,
    wins: [0, 0],
    gamesPlayed: 0,
    completed: false,
    winnerPlayerId: null
  };
}

export function beginCountdown(
  state: RoomState,
  atMs: number,
  origin: "lobby" | "between_games" | "series_complete",
  policy: RoomPolicy
): { readonly state: RoomState; readonly effects: readonly RoomEffect[] } {
  const series =
    origin === "between_games" && state.series !== null
      ? state.series
      : createSeries(state);
  const countdownId = state.nextCountdownNumber;
  const startsAtMs = atMs + policy.countdownMs;
  return {
    state: {
      ...state,
      phase: "countdown",
      rulesStatus: "locked",
      countdown: {
        countdownId,
        startsAtMs,
        origin,
        gameNumber: series.gamesPlayed + 1
      },
      series,
      activeMatch: null,
      rematchVotes: [false, false],
      nextCountdownNumber: countdownId + 1,
      nextSeriesNumber:
        series === state.series
          ? state.nextSeriesNumber
          : state.nextSeriesNumber + 1
    },
    effects: [{ type: "countdown.schedule", countdownId, startsAtMs }]
  };
}

export function removeMemberState(
  state: RoomState,
  playerId: string,
  denyFutureJoin: boolean
): { readonly state: RoomState; readonly effects: readonly RoomEffect[] } {
  const occupiedSeat = seatOf(state, playerId);
  const seats: [string | null, string | null] = [
    occupiedSeat === 0 ? null : state.seats[0],
    occupiedSeat === 1 ? null : state.seats[1]
  ];
  let proposed: RoomState = {
    ...state,
    members: withoutMember(state.members, playerId),
    seats,
    deniedPlayerIds:
      denyFutureJoin && !state.deniedPlayerIds.includes(playerId)
        ? [...state.deniedPlayerIds, playerId].slice(-MAX_DENIED_PLAYER_IDS)
        : state.deniedPlayerIds
  };
  const effects =
    occupiedSeat === null
      ? []
      : countdownCancelEffect(state, "roster_changed");
  if (occupiedSeat !== null) proposed = resetCompetition(proposed);
  if (state.hostPlayerId === playerId) {
    proposed = { ...proposed, hostPlayerId: chooseHost(proposed) };
  }
  return { state: proposed, effects };
}

export function closeState(
  state: RoomState,
  reason: "expired" | "host_closed" | "server_shutdown"
): RoomState {
  return {
    ...state,
    phase: "closed",
    members: {},
    seats: [null, null],
    hostPlayerId: null,
    ready: [false, false],
    rematchVotes: [false, false],
    rulesStatus: "draft",
    countdown: null,
    series: null,
    activeMatch: null,
    closedReason: reason
  };
}
