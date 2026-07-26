export type SeatIndex = 0 | 1;
export type TargetWins = 1 | 2 | 3 | 5;

export const TARGET_WINS_OPTIONS = [1, 2, 3, 5] as const;

export type RoomPhase =
  | "lobby"
  | "countdown"
  | "playing"
  | "between_games"
  | "series_complete"
  | "closed";

export const MAX_DENIED_PLAYER_IDS = 64;

export interface RoomPolicy {
  readonly countdownMs: number;
  readonly maxSpectators: number;
  readonly matchReconnectGraceMs: number;
  readonly lobbyReconnectGraceMs: number;
  readonly emptyTtlMs: number;
  readonly lobbyIdleTtlMs: number;
  readonly seriesCompleteTtlMs: number;
  readonly absoluteTtlMs: number;
}

export const DEFAULT_ROOM_POLICY: RoomPolicy = Object.freeze({
  countdownMs: 3_000,
  maxSpectators: 6,
  matchReconnectGraceMs: 15_000,
  lobbyReconnectGraceMs: 60_000,
  emptyTtlMs: 120_000,
  lobbyIdleTtlMs: 30 * 60_000,
  seriesCompleteTtlMs: 15 * 60_000,
  absoluteTtlMs: 6 * 60 * 60_000
});

export interface PublicRoomPlayer {
  readonly playerId: string;
  readonly displayName: string;
}

export type RoomConnection =
  | {
      readonly kind: "connected";
      readonly connectionId: string;
      readonly epoch: number;
  }
  | {
      readonly kind: "disconnected";
      readonly epoch: number;
      readonly reconnectDeadlineMs: number;
      /** Prevents duplicate disconnect-forfeit effects after the grace timer fires. */
      readonly forfeitRequested: boolean;
  };

export interface RoomMember {
  readonly player: PublicRoomPlayer;
  readonly joinedOrdinal: number;
  readonly connection: RoomConnection;
}

export interface RoomSettings {
  readonly targetWins: TargetWins;
  readonly allowSpectators: boolean;
}

export interface RoomCountdown {
  readonly countdownId: number;
  readonly startsAtMs: number;
  readonly origin: "lobby" | "between_games" | "series_complete";
  readonly gameNumber: number;
}

export interface RoomSeries {
  readonly seriesId: string;
  readonly roster: readonly [string, string];
  readonly targetWins: TargetWins;
  readonly wins: readonly [number, number];
  readonly gamesPlayed: number;
  readonly completed: boolean;
  readonly winnerPlayerId: string | null;
}

export interface ActiveRoomMatch {
  readonly matchId: string;
  readonly gameNumber: number;
  readonly participants: readonly [string, string];
  readonly startedAtMs: number;
  readonly resolutionRequested: boolean;
}

export type RoomClosedReason = "expired" | "host_closed" | "server_shutdown";

export interface RoomState {
  readonly roomId: string;
  readonly roomCode: string;
  readonly revision: number;
  /** Advances for every public presence/state change, including spectator churn. */
  readonly presenceSequence: number;
  readonly phase: RoomPhase;
  readonly members: Readonly<Record<string, RoomMember>>;
  readonly seats: readonly [string | null, string | null];
  /** Host is an independent permission axis and may be a seated player or spectator. */
  readonly hostPlayerId: string | null;
  readonly ready: readonly [boolean, boolean];
  readonly rematchVotes: readonly [boolean, boolean];
  readonly settings: RoomSettings;
  readonly rulesStatus: "draft" | "locked";
  readonly countdown: RoomCountdown | null;
  readonly series: RoomSeries | null;
  readonly activeMatch: ActiveRoomMatch | null;
  readonly deniedPlayerIds: readonly string[];
  readonly nextJoinedOrdinal: number;
  readonly nextCountdownNumber: number;
  readonly nextSeriesNumber: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly expiresAtMs: number;
  readonly absoluteExpiresAtMs: number;
  readonly closedReason: RoomClosedReason | null;
}

export interface CreateRoomInput {
  readonly roomId: string;
  readonly roomCode: string;
  readonly creator: PublicRoomPlayer;
  readonly connectionId: string;
  readonly nowMs: number;
  readonly settings?: Partial<RoomSettings>;
}

interface RequestBase {
  readonly requestId: string;
  readonly actorPlayerId: string;
  readonly atMs: number;
}

interface VersionedRequestBase extends RequestBase {
  readonly expectedRevision: number;
}

export type RoomCommand =
  | {
      readonly type: "member.join";
      readonly requestId: string;
      readonly player: PublicRoomPlayer;
      readonly connectionId: string;
      readonly participation: "player" | "spectator";
      readonly preferredSeat?: SeatIndex;
      readonly atMs: number;
  }
  | (VersionedRequestBase & { readonly type: "member.leave" })
  | (VersionedRequestBase & {
      readonly type: "seat.set";
      readonly seat: SeatIndex | null;
  })
  | (VersionedRequestBase & {
      readonly type: "ready.set";
      readonly ready: boolean;
  })
  | (VersionedRequestBase & {
      readonly type: "settings.update";
      readonly patch: Partial<RoomSettings>;
  })
  | (VersionedRequestBase & {
      readonly type: "host.transfer";
      readonly targetPlayerId: string;
  })
  | (VersionedRequestBase & {
      readonly type: "member.kick";
      readonly targetPlayerId: string;
  })
  | (VersionedRequestBase & {
      readonly type: "series.rematch";
      readonly accepted: boolean;
  })
  | (VersionedRequestBase & { readonly type: "room.close" })
  | {
      readonly type: "connection.lost";
      readonly playerId: string;
      readonly connectionId: string;
      readonly expectedConnectionEpoch: number;
      readonly atMs: number;
  }
  | {
      readonly type: "connection.resumed";
      readonly playerId: string;
      readonly expectedConnectionEpoch: number;
      readonly newConnectionId: string;
      readonly atMs: number;
  }
  | {
      readonly type: "connection.replace";
      readonly playerId: string;
      readonly expectedConnectionId: string;
      readonly expectedConnectionEpoch: number;
      readonly newConnectionId: string;
      readonly atMs: number;
  }
  | {
      readonly type: "timer.reconnect_elapsed";
      readonly playerId: string;
      readonly expectedConnectionEpoch: number;
      readonly atMs: number;
  }
  | {
      readonly type: "timer.countdown_elapsed";
      readonly countdownId: number;
      readonly matchId: string;
      readonly atMs: number;
  }
  | {
      readonly type: "match.finished";
      readonly matchId: string;
      readonly winnerPlayerId: string | null;
      readonly reason:
        | "topout"
        | "forfeit"
        | "disconnect_timeout"
        | "simultaneous_topout"
        | "draw";
      readonly serverFrame: number;
      readonly atMs: number;
  }
  | {
      readonly type: "timer.room_expired";
      readonly atMs: number;
  }
  | {
      readonly type: "admin.close";
      readonly reason: "server_shutdown";
      readonly atMs: number;
  };

export type RoomErrorCode =
  | "INVALID_COMMAND"
  | "REQUEST_ID_REUSED"
  | "REVISION_CONFLICT"
  | "ROOM_CLOSED"
  | "ROOM_FULL"
  | "ROOM_KICKED"
  | "ALREADY_IN_ROOM"
  | "NOT_IN_ROOM"
  | "NOT_CONNECTED"
  | "NOT_SEATED"
  | "NOT_HOST"
  | "TARGET_NOT_MEMBER"
  | "TARGET_NOT_CONNECTED"
  | "CANNOT_KICK_SELF"
  | "CANNOT_KICK_ACTIVE_PLAYER"
  | "SEAT_OCCUPIED"
  | "SPECTATING_DISABLED"
  | "SPECTATOR_LIMIT"
  | "RULES_INVALID"
  | "RULES_LOCKED"
  | "INVALID_ROOM_PHASE"
  | "ACTIVE_MATCH"
  | "MATCH_NOT_ACTIVE"
  | "SERIES_NOT_COMPLETE"
  | "NO_CHANGE"
  | "RESUME_EXPIRED";

export type RoomEffect =
  | {
      readonly type: "room.state_changed";
      readonly revision: number;
      readonly presenceSequence: number;
    }
  | {
      readonly type: "countdown.schedule";
      readonly countdownId: number;
      readonly startsAtMs: number;
  }
  | {
      readonly type: "countdown.cancel";
      readonly countdownId: number;
      readonly reason: "unready" | "disconnect" | "roster_changed";
  }
  | {
      readonly type: "match.start";
      readonly matchId: string;
      readonly seriesId: string;
      readonly gameNumber: number;
      readonly participants: readonly [string, string];
  }
  | {
      readonly type: "match.clear_input";
      readonly playerId: string;
  }
  | {
      readonly type: "match.disconnect_forfeit";
      readonly matchId: string;
      readonly loserPlayerId: string;
      readonly winnerPlayerId: string | null;
  }
  | {
      readonly type: "member.reconnect_deadline";
      readonly playerId: string;
      readonly deadlineMs: number;
  }
  | { readonly type: "member.reconnect_expired"; readonly playerId: string }
  | { readonly type: "member.kicked"; readonly playerId: string }
  | { readonly type: "room.closed"; readonly reason: RoomClosedReason };

export type RoomTransition =
  | {
      readonly kind: "committed";
      readonly state: RoomState;
      readonly effects: readonly RoomEffect[];
  }
  | {
      readonly kind: "rejected";
      readonly state: RoomState;
      readonly code: RoomErrorCode;
      readonly currentRevision: number;
  }
  | {
      readonly kind: "ignored";
      readonly state: RoomState;
      readonly reason: "stale_connection" | "stale_timer" | "stale_match";
  };
