import { MAX_DENIED_PLAYER_IDS } from "./model.ts";
import type { RoomState } from "./model.ts";
import {
  ROOM_CODE,
  SAFE_ID,
  connected,
  isSafeTime,
  isTargetWins,
  isValidPlayer,
  ownMember
} from "./validation.ts";

export function assertRoomInvariants(state: RoomState): void {
  const fail = (message: string): never => {
    throw new Error(`Room invariant failed: ${message}`);
  };
  if (
    !SAFE_ID.test(state.roomId) ||
    !ROOM_CODE.test(state.roomCode) ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 1 ||
    !Number.isSafeInteger(state.presenceSequence) ||
    state.presenceSequence < state.revision
  ) {
    fail("identity or revision");
  }
  if (
    !isSafeTime(state.createdAtMs) ||
    !isSafeTime(state.updatedAtMs) ||
    !isSafeTime(state.expiresAtMs) ||
    !isSafeTime(state.absoluteExpiresAtMs) ||
    state.createdAtMs > state.updatedAtMs ||
    state.absoluteExpiresAtMs < state.createdAtMs
  ) {
    fail("timestamps");
  }
  const memberIds = Object.keys(state.members);
  const ordinals = new Set<number>();
  const connectionIds = new Set<string>();
  for (const [playerId, member] of Object.entries(state.members)) {
    if (playerId !== member.player.playerId || !isValidPlayer(member.player)) {
      fail("member identity");
    }
    if (
      !Number.isSafeInteger(member.joinedOrdinal) ||
      member.joinedOrdinal < 1 ||
      ordinals.has(member.joinedOrdinal)
    ) {
      fail("member ordinal");
    }
    ordinals.add(member.joinedOrdinal);
    if (
      !Number.isSafeInteger(member.connection.epoch) ||
      member.connection.epoch < 0
    ) {
      fail("connection epoch");
    }
    if (member.connection.kind === "connected") {
      if (
        !SAFE_ID.test(member.connection.connectionId) ||
        connectionIds.has(member.connection.connectionId)
      ) {
        fail("connection id");
      }
      connectionIds.add(member.connection.connectionId);
    } else if (!isSafeTime(member.connection.reconnectDeadlineMs)) {
      fail("reconnect deadline");
    }
  }
  const occupied = state.seats.filter(
    (playerId): playerId is string => playerId !== null
  );
  if (
    new Set(occupied).size !== occupied.length ||
    occupied.some((playerId) => !ownMember(state.members, playerId))
  ) {
    fail("seat membership");
  }
  if (
    (state.hostPlayerId !== null &&
      !ownMember(state.members, state.hostPlayerId)) ||
    (memberIds.length === 0 && state.hostPlayerId !== null) ||
    (Object.values(state.members).some(connected) &&
      state.phase !== "closed" &&
      state.hostPlayerId === null)
  ) {
    fail("host membership");
  }
  for (const seat of [0, 1] as const) {
    const playerId = state.seats[seat];
    if (
      state.ready[seat] &&
      (playerId === null || !connected(ownMember(state.members, playerId)))
    ) {
      fail("ready player must be connected and seated");
    }
  }
  if (
    !isTargetWins(state.settings.targetWins) ||
    typeof state.settings.allowSpectators !== "boolean"
  ) {
    fail("settings");
  }
  if (
    state.deniedPlayerIds.length > MAX_DENIED_PLAYER_IDS ||
    new Set(state.deniedPlayerIds).size !== state.deniedPlayerIds.length ||
    state.deniedPlayerIds.some(
      (playerId) =>
        !SAFE_ID.test(playerId) || !!ownMember(state.members, playerId)
    )
  ) {
    fail("denylist");
  }
  if (state.series !== null) {
    const [left, right] = state.series.roster;
    if (
      left === right ||
      !isTargetWins(state.series.targetWins) ||
      state.series.wins.some(
        (wins) => !Number.isSafeInteger(wins) || wins < 0
      ) ||
      !Number.isSafeInteger(state.series.gamesPlayed) ||
      state.series.gamesPlayed < state.series.wins[0] + state.series.wins[1] ||
      state.series.completed !==
        (state.series.wins[0] >= state.series.targetWins ||
          state.series.wins[1] >= state.series.targetWins)
    ) {
      fail("series counters");
    }
    if (
      (state.series.completed && state.series.winnerPlayerId === null) ||
      (!state.series.completed && state.series.winnerPlayerId !== null) ||
      (state.series.winnerPlayerId !== null &&
        !state.series.roster.includes(state.series.winnerPlayerId))
    ) {
      fail("series winner");
    }
  }
  if (state.phase === "lobby") {
    if (
      state.rulesStatus !== "draft" ||
      state.countdown !== null ||
      state.series !== null ||
      state.activeMatch !== null
    ) {
      fail("lobby shape");
    }
  } else if (state.phase === "countdown") {
    if (
      state.rulesStatus !== "locked" ||
      state.countdown === null ||
      state.series === null ||
      state.activeMatch !== null ||
      !state.ready[0] ||
      !state.ready[1] ||
      state.seats[0] !== state.series.roster[0] ||
      state.seats[1] !== state.series.roster[1]
    ) {
      fail("countdown shape");
    }
  } else if (state.phase === "playing") {
    if (
      state.rulesStatus !== "locked" ||
      state.countdown !== null ||
      state.series === null ||
      state.activeMatch === null ||
      typeof state.activeMatch.resolutionRequested !== "boolean" ||
      state.ready[0] ||
      state.ready[1] ||
      state.activeMatch.participants[0] !== state.series.roster[0] ||
      state.activeMatch.participants[1] !== state.series.roster[1]
    ) {
      fail("playing shape");
    }
  } else if (state.phase === "between_games") {
    if (
      state.rulesStatus !== "locked" ||
      state.countdown !== null ||
      state.series === null ||
      state.series.completed ||
      state.activeMatch !== null
    ) {
      fail("between-games shape");
    }
  } else if (state.phase === "series_complete") {
    if (
      state.rulesStatus !== "draft" ||
      state.countdown !== null ||
      state.series === null ||
      !state.series.completed ||
      state.activeMatch !== null ||
      state.ready[0] ||
      state.ready[1]
    ) {
      fail("series-complete shape");
    }
  } else if (
    memberIds.length !== 0 ||
    state.hostPlayerId !== null ||
    occupied.length !== 0 ||
    state.countdown !== null ||
    state.series !== null ||
    state.activeMatch !== null ||
    state.closedReason === null
  ) {
    fail("closed shape");
  }
}
