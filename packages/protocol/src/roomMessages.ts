import type {
  RoomClosedReason,
  RoomPhase,
  RoomSettings,
  SeatIndex
} from "../../room-core/src/model.ts";

export interface RoomMutationFields {
  readonly requestId: string;
  readonly roomId: string;
  readonly expectedRevision: number;
}

export type RoomClientMessage =
  | {
      readonly type: "room.create";
      readonly requestId: string;
      readonly settings?: Partial<RoomSettings>;
    }
  | {
      readonly type: "room.join";
      readonly requestId: string;
      readonly roomCode: string;
      readonly participation: "player" | "spectator";
      readonly preferredSeat?: SeatIndex;
    }
  | (RoomMutationFields & { readonly type: "room.leave" })
  | (RoomMutationFields & {
      readonly type: "room.seat.set";
      readonly seat: SeatIndex | null;
    })
  | (RoomMutationFields & {
      readonly type: "room.ready.set";
      readonly ready: boolean;
    })
  | (RoomMutationFields & {
      readonly type: "room.settings.update";
      readonly patch: Partial<RoomSettings>;
    })
  | (RoomMutationFields & {
      readonly type: "room.host.transfer";
      readonly targetPlayerId: string;
    })
  | (RoomMutationFields & {
      readonly type: "room.member.kick";
      readonly targetPlayerId: string;
    })
  | (RoomMutationFields & {
      readonly type: "room.series.rematch";
      readonly accepted: boolean;
    })
  | (RoomMutationFields & { readonly type: "room.close" });

export interface PublicPlayer {
  readonly playerId: string;
  readonly displayName: string;
}

export interface RoomSeatView extends PublicPlayer {
  readonly seat: SeatIndex;
  readonly connected: boolean;
  readonly ready: boolean;
  readonly rematchAccepted: boolean;
}

export interface RoomSpectatorView extends PublicPlayer {
  readonly connected: boolean;
  readonly isHost: boolean;
}

export interface RoomSelfView {
  readonly playerId: string;
  readonly participation: "player" | "spectator";
  readonly seat: SeatIndex | null;
  readonly permissions: {
    readonly editSettings: boolean;
    readonly transferHost: boolean;
    readonly kickMembers: boolean;
    readonly closeRoom: boolean;
    readonly ready: boolean;
    readonly voteRematch: boolean;
  };
}

export interface RoomSeriesView {
  readonly seriesId: string;
  readonly roster: readonly [string, string];
  readonly targetWins: RoomSettings["targetWins"];
  readonly wins: readonly [number, number];
  readonly gamesPlayed: number;
  readonly completed: boolean;
  readonly winnerPlayerId: string | null;
}

export interface RoomStatePayload {
  readonly roomId: string;
  readonly roomCode: string;
  readonly revision: number;
  readonly presenceSequence: number;
  readonly phase: RoomPhase;
  readonly hostPlayerId: string | null;
  readonly self: RoomSelfView;
  readonly seats: readonly [RoomSeatView | null, RoomSeatView | null];
  readonly spectators: readonly RoomSpectatorView[];
  readonly settings: RoomSettings;
  readonly rulesStatus: "draft" | "locked";
  readonly countdown: {
    readonly countdownId: number;
    readonly startsAtServerTime: number;
    readonly gameNumber: number;
  } | null;
  readonly series: RoomSeriesView | null;
  readonly activeMatch: {
    readonly matchId: string;
    readonly gameNumber: number;
    readonly participants: readonly [string, string];
    readonly startedAtServerTime: number;
  } | null;
  readonly expiresAtServerTime: number;
}

export type RoomServerMessage =
  | {
      readonly type: "room.state";
      readonly state: RoomStatePayload;
    }
  | {
      readonly type: "room.command.ok";
      readonly requestId: string;
      readonly roomId: string;
      readonly revision: number;
      readonly replayed: boolean;
    }
  | {
      readonly type: "room.removed";
      readonly roomId: string;
      readonly reason: "left" | "kicked" | "reconnect_timeout";
    }
  | {
      readonly type: "room.closed";
      readonly roomId: string;
      readonly reason: RoomClosedReason;
    };
