import type {
  RoomMember,
  RoomState,
  SeatIndex
} from "../../../../packages/room-core/src/model.ts";
import type {
  RoomSeatView,
  RoomSpectatorView,
  RoomStatePayload
} from "../../../../packages/protocol/src/roomMessages.ts";

function connected(member: RoomMember): boolean {
  return member.connection.kind === "connected";
}

function seatOf(state: RoomState, playerId: string): SeatIndex | null {
  if (state.seats[0] === playerId) return 0;
  if (state.seats[1] === playerId) return 1;
  return null;
}

function seatView(
  state: RoomState,
  seat: SeatIndex
): RoomSeatView | null {
  const playerId = state.seats[seat];
  if (playerId === null) return null;
  const member = state.members[playerId];
  if (member === undefined) throw new Error("Room seat references a missing member.");
  return {
    ...member.player,
    seat,
    connected: connected(member),
    ready: state.ready[seat],
    rematchAccepted: state.rematchVotes[seat]
  };
}

function spectatorViews(state: RoomState): readonly RoomSpectatorView[] {
  return Object.entries(state.members)
    .filter(([playerId]) => seatOf(state, playerId) === null)
    .sort(
      ([, left], [, right]) => left.joinedOrdinal - right.joinedOrdinal
    )
    .map(([playerId, member]) => ({
      ...member.player,
      connected: connected(member),
      isHost: state.hostPlayerId === playerId
    }));
}

export function projectRoomState(
  state: RoomState,
  viewerPlayerId: string
): RoomStatePayload {
  if (state.phase === "closed") {
    throw new Error("Closed rooms use room.closed instead of room.state.");
  }
  const member = state.members[viewerPlayerId];
  if (member === undefined) throw new Error("Viewer is not a room member.");
  const seat = seatOf(state, viewerPlayerId);
  const isHost = state.hostPlayerId === viewerPlayerId;
  const editablePhase =
    state.phase === "lobby" || state.phase === "series_complete";
  const canReady =
    seat !== null &&
    connected(member) &&
    (state.phase === "lobby" ||
      state.phase === "between_games" ||
      state.phase === "countdown");

  return {
    roomId: state.roomId,
    roomCode: state.roomCode,
    revision: state.revision,
    presenceSequence: state.presenceSequence,
    phase: state.phase,
    hostPlayerId: state.hostPlayerId,
    self: {
      playerId: viewerPlayerId,
      participation: seat === null ? "spectator" : "player",
      seat,
      permissions: {
        editSettings: isHost && editablePhase,
        transferHost: isHost && editablePhase,
        kickMembers: isHost,
        closeRoom: isHost && editablePhase,
        ready: canReady,
        voteRematch: seat !== null && state.phase === "series_complete"
      }
    },
    seats: [seatView(state, 0), seatView(state, 1)],
    spectators: spectatorViews(state),
    settings: state.settings,
    rulesStatus: state.rulesStatus,
    countdown:
      state.countdown === null
        ? null
        : {
            countdownId: state.countdown.countdownId,
            startsAtServerTime: state.countdown.startsAtMs,
            gameNumber: state.countdown.gameNumber
          },
    series:
      state.series === null
        ? null
        : {
            seriesId: state.series.seriesId,
            roster: state.series.roster,
            targetWins: state.series.targetWins,
            wins: state.series.wins,
            gamesPlayed: state.series.gamesPlayed,
            completed: state.series.completed,
            winnerPlayerId: state.series.winnerPlayerId
          },
    activeMatch:
      state.activeMatch === null
        ? null
        : {
            matchId: state.activeMatch.matchId,
            gameNumber: state.activeMatch.gameNumber,
            participants: state.activeMatch.participants,
            startedAtServerTime: state.activeMatch.startedAtMs
          },
    expiresAtServerTime: state.expiresAtMs
  };
}
