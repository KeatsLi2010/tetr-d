import type {
  PieceKind,
  RotationDirection
} from "../../game-core/src/index.ts";
import type { PublicPlayer } from "./roomMessages.ts";
import {
  PIECE_SEQUENCE_VERSION,
  RULESET_VERSION
} from "./versions.ts";

export type InputAction =
  | { readonly kind: "move"; readonly direction: "left" | "right"; readonly pressed: boolean }
  | { readonly kind: "moveStep"; readonly direction: "left" | "right" }
  | { readonly kind: "moveToWall"; readonly direction: "left" | "right" }
  | { readonly kind: "softDrop"; readonly pressed: boolean }
  | { readonly kind: "softDropStep"; readonly cells: number }
  | { readonly kind: "sonicDrop" }
  | { readonly kind: "clearHeld" }
  | { readonly kind: "hardDrop" }
  | { readonly kind: "rotate"; readonly direction: RotationDirection }
  | { readonly kind: "hold" };

export type MatchClientMessage =
  | {
      readonly type: "match.forfeit";
      readonly requestId: string;
      readonly roomId: string;
      readonly matchId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: "match.input";
      readonly matchId: string;
      readonly inputEpoch: number;
      readonly sequence: number;
      readonly clientFrame: number;
      readonly actions: readonly InputAction[];
    }
  | {
      readonly type: "match.resyncRequest";
      readonly matchId: string;
      readonly lastStateSequence: number;
      readonly lastEventSequence: number;
    }
  | {
      /**
       * Ephemeral DG-LAB display state. This is deliberately separate from
       * simulation snapshots so it is never persisted in a replay.
       */
      readonly type: "match.feedback";
      readonly matchId: string;
      readonly visible: boolean;
      readonly connected: boolean;
      readonly armed: boolean;
      readonly channelA: MatchFeedbackChannel;
      readonly channelB: MatchFeedbackChannel;
    };

export interface MatchFeedbackChannel {
  readonly strength: number;
  readonly limit: number;
}

export interface MatchFeedbackState {
  readonly visible: boolean;
  readonly connected: boolean;
  readonly armed: boolean;
  readonly channelA: MatchFeedbackChannel;
  readonly channelB: MatchFeedbackChannel;
}

export interface PendingGarbagePacket {
  readonly packetId: string;
  readonly sourcePlayerId: string;
  readonly amount: number;
  readonly appliesAtFrame: number;
}

export interface PrivatePendingGarbagePacket extends PendingGarbagePacket {
  readonly holeSeed: number;
}

export interface PlayerSnapshot {
  readonly playerId: string;
  readonly boardRows: readonly number[];
  readonly garbageRows: readonly boolean[];
  readonly active: {
    readonly kind: PieceKind;
    readonly rotation: number;
    readonly x: number;
    readonly y: number;
  } | null;
  readonly hold: PieceKind | null;
  readonly next: readonly PieceKind[];
  readonly combo: number;
  readonly backToBack: number;
  readonly piecesPlaced: number;
  readonly totalAttackSent: number;
  readonly pendingGarbage: readonly PendingGarbagePacket[];
  readonly toppedOut: boolean;
}

/**
 * Sent only for the receiving player's own board. The finite piece window is
 * authorized for local prediction; the server never sends the live seed.
 */
export interface PrivateSimulationSnapshot {
  readonly playerId: string;
  readonly pieceCursor: number;
  readonly pieceWindow: readonly PieceKind[];
  readonly heldInputMask: number;
  readonly dasFrames: number;
  readonly arrFrames: number;
  readonly gravity256: number;
  readonly lockFrames: number;
  readonly lockResets: number;
  readonly canHold: boolean;
  readonly pendingGarbage: readonly PrivatePendingGarbagePacket[];
}

export type InputDisposition =
  | {
      readonly sequence: number;
      readonly status: "scheduled" | "applied";
      readonly serverFrame: number;
    }
  | {
      readonly sequence: number;
      readonly status: "rejected";
      readonly reason: "gap" | "late" | "too_far_future" | "invalid" | "rate_limited";
    };

export interface InputAcknowledgement {
  readonly inputEpoch: number;
  readonly receivedThroughSequence: number;
  readonly settledThroughSequence: number;
  readonly dispositions: readonly InputDisposition[];
}

export interface PlayerPatch {
  readonly playerId: string;
  readonly changedRows?: readonly {
    readonly y: number;
    readonly bits: number;
    readonly garbage: boolean;
  }[];
  readonly active?: PlayerSnapshot["active"];
  readonly hold?: PieceKind | null;
  readonly next?: readonly PieceKind[];
  readonly combo?: number;
  readonly backToBack?: number;
  readonly piecesPlaced?: number;
  readonly totalAttackSent?: number;
  readonly pendingGarbage?: readonly PendingGarbagePacket[];
  readonly toppedOut?: boolean;
}

export type MatchEvent =
  | {
      readonly eventSequence: number;
      readonly kind: "garbage.queued";
      readonly packet: PendingGarbagePacket;
      readonly targetPlayerId: string;
      readonly holeSeed?: number;
    }
  | {
      readonly eventSequence: number;
      readonly kind: "garbage.applied";
      readonly packetId: string;
      readonly targetPlayerId: string;
      readonly holes: readonly number[];
    }
  | {
      readonly eventSequence: number;
      readonly kind: "ko";
      readonly loserPlayerId: string;
      readonly reason: "blockout" | "lockout" | "disconnect_timeout" | "forfeit";
    };

export type MatchServerMessage =
  | {
      readonly type: "match.countdown";
      readonly roomId: string;
      readonly countdownId: number;
      readonly seriesId: string;
      readonly gameNumber: number;
      readonly startsAtServerTime: number;
    }
  | {
      readonly type: "match.start";
      readonly matchId: string;
      readonly pieceSequenceVersion: typeof PIECE_SEQUENCE_VERSION;
      readonly pieceSequenceCommitment: string;
      readonly selfPieceCursor: number | null;
      readonly selfPieceWindow: readonly PieceKind[];
      readonly rulesetVersion: typeof RULESET_VERSION;
      /** Authoritative simulation frequency; transport snapshots are slower. */
      readonly simulationHz: number;
      /** Attack warning travel time in authoritative simulation frames. */
      readonly garbageTravelFrames: number;
      readonly inputEpoch: number | null;
      readonly serverFrame: number;
      readonly players: readonly PublicPlayer[];
    }
  | {
      readonly type: "match.inputAck";
      readonly matchId: string;
      readonly serverFrame: number;
      readonly selfStateHash: string;
      readonly acknowledgement: InputAcknowledgement;
    }
  | {
      readonly type: "match.snapshot";
      readonly matchId: string;
      readonly stateSequence: number;
      readonly lastEventSequence: number;
      readonly serverFrame: number;
      readonly publicStateHash: string;
      readonly selfStateHash: string | null;
      readonly players: readonly PlayerSnapshot[];
      readonly self: PrivateSimulationSnapshot | null;
      readonly acknowledgement?: InputAcknowledgement;
    }
  | {
      readonly type: "match.delta";
      readonly matchId: string;
      readonly stateSequence: number;
      readonly baseStateSequence: number;
      readonly basePublicStateHash: string;
      readonly lastEventSequence: number;
      readonly serverFrame: number;
      readonly publicStateHash: string;
      readonly selfStateHash: string | null;
      readonly patches: readonly PlayerPatch[];
      readonly events: readonly MatchEvent[];
      readonly self: PrivateSimulationSnapshot | null;
      readonly acknowledgement?: InputAcknowledgement;
    }
  | {
      readonly type: "match.presence";
      readonly matchId: string;
      readonly playerId: string;
      readonly connected: boolean;
      readonly graceDeadlineServerTime?: number;
    }
  | {
      /** Ephemeral DG-LAB state; never included in snapshots or replays. */
      readonly type: "match.feedback";
      readonly matchId: string;
      readonly playerId: string;
      readonly feedback: MatchFeedbackState;
    }
  | {
      readonly type: "resume.ok";
      readonly matchId: string;
      readonly inputEpoch: number;
      readonly nextInputSequence: number;
      readonly newResumeToken: string;
      readonly snapshot: readonly PlayerSnapshot[];
      readonly self: PrivateSimulationSnapshot;
      readonly stateSequence: number;
      readonly lastEventSequence: number;
      readonly serverFrame: number;
      readonly publicStateHash: string;
      readonly selfStateHash: string;
    }
  | {
      readonly type: "match.end";
      readonly matchId: string;
      readonly serverFrame: number;
      readonly winnerPlayerId: string | null;
      readonly reason:
        | "topout"
        | "disconnect_timeout"
        | "forfeit"
        | "simultaneous_topout"
        | "draw";
      readonly pieceSequenceReveal: {
        readonly version: 1;
        readonly matchId: string;
        readonly rulesetVersion: typeof RULESET_VERSION;
        readonly seedHex: string;
      };
    };
