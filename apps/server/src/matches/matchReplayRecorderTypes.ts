import type {
  InputAction
} from "../../../../packages/protocol/src/matchMessages.ts";
import type {
  MatchPieceSequenceReveal
} from "../matchPieceSequence.ts";
import type {
  MatchRandomSeeds
} from "./matchRandom.ts";
import type {
  ScheduledMatchInput
} from "./matchInputQueue.ts";

export interface MatchReplayPlayer {
  readonly playerId: string;
  readonly displayName: string;
}

export interface MatchReplaySeedCommitment {
  readonly pieceSequence: string;
  readonly matchRandom: string;
}

export interface MatchReplayRecorderOptions {
  readonly rootDirectory: string;
  readonly matchId: string;
  readonly createdAtMs: number;
  readonly serverVersion: string;
  readonly protocolVersion: string | number;
  readonly rulesetVersion: string;
  readonly rotationSystemVersion: string;
  readonly pieceSequenceVersion: string;
  readonly tickHz: number;
  readonly garbageTravelFrames: number;
  readonly players: readonly [MatchReplayPlayer, MatchReplayPlayer];
  readonly randomSeedCommitment: MatchReplaySeedCommitment;
  readonly maxPendingRecords?: number;
}

export interface MatchReplayAppliedFrame {
  readonly serverFrame: number;
  /**
   * Exactly the envelopes returned by MatchInputQueue.drain for this frame.
   * The recorder groups them in configured participant order.
   */
  readonly drainedInputs: readonly ScheduledMatchInput[];
}

export type MatchReplayControl =
  | {
      readonly kind: "clearHeld";
      readonly playerId: string;
    }
  | {
      readonly kind: "resetInput";
      readonly playerId: string;
      readonly inputEpoch: number;
    };

export interface MatchReplayControlFrame {
  readonly serverFrame: number;
  readonly controls: readonly MatchReplayControl[];
}

export type MatchReplayEndReason =
  | "topout"
  | "forfeit"
  | "disconnect_timeout"
  | "simultaneous_topout"
  | "draw";

export interface MatchReplayFinalStateHash {
  readonly playerId: string;
  readonly hash: string;
}

export interface MatchReplayFinalize {
  readonly serverFrame: number;
  readonly winnerPlayerId: string | null;
  readonly reason: MatchReplayEndReason;
  readonly randomSeedReveal: {
    readonly pieceSequence: MatchPieceSequenceReveal;
    readonly matchRandom: MatchRandomSeeds;
  };
  readonly finalStateHashes?: readonly [
    MatchReplayFinalStateHash,
    MatchReplayFinalStateHash
  ];
}

export interface MatchReplaySourceSummary {
  readonly inputEpoch: number;
  readonly sequence: number;
  readonly actionCount: number;
}

export interface MatchReplayPlayerActions {
  readonly playerId: string;
  readonly actions: readonly InputAction[];
  readonly sourceSequences: readonly number[];
  readonly sources: readonly MatchReplaySourceSummary[];
}
