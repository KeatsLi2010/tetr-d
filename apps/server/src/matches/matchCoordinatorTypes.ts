import type { PublicPlayer } from "../../../../packages/protocol/src/roomMessages.ts";
import type {
  InputAcknowledgement,
  MatchServerMessage
} from "../../../../packages/protocol/src/matchMessages.ts";
import type { MatchPieceSequence } from "../matchPieceSequence.ts";
import type { MatchRandomSeeds } from "./matchRandom.ts";
import type { Board } from "../../../../packages/game-core/src/board.ts";

export interface MatchCoordinatorOptions {
  readonly matchId: string;
  readonly roomId: string;
  readonly participants: readonly [string, string];
  readonly players: readonly [PublicPlayer, PublicPlayer];
  readonly sequence: MatchPieceSequence;
  readonly tickRateHz: number;
  readonly snapshotRateHz?: number;
  readonly randomSeeds?: MatchRandomSeeds;
  /** Replay/test injection; production starts both players empty. */
  readonly initialBoards?: readonly [Board, Board];
  readonly onSnapshot?: (coordinator: MatchCoordinatorView) => void;
  readonly onFinished?: (result: MatchFinishedResult) => void;
  readonly onError?: (error: unknown) => void;
}

export interface MatchFinishedResult {
  readonly roomId: string;
  readonly matchId: string;
  readonly serverFrame: number;
  readonly winnerPlayerId: string | null;
  readonly reason:
    | "topout"
    | "forfeit"
    | "disconnect_timeout"
    | "simultaneous_topout"
    | "draw";
  readonly message: Extract<MatchServerMessage, { readonly type: "match.end" }>;
}

export interface MatchCoordinatorView {
  readonly matchId: string;
  readonly roomId: string;
  readonly participants: readonly [string, string];
  readonly players: MatchCoordinatorOptions["players"];
  readonly tickRateHz: number;
  readonly serverFrame: number;
  readonly stateSequence: number;
  readonly lastEventSequence: number;
  readonly finished: boolean;
  readonly simulations: readonly [
    import("../../../../packages/game-core/src/playerSimulation.ts").PlayerSimulation,
    import("../../../../packages/game-core/src/playerSimulation.ts").PlayerSimulation
  ];
}

export interface MatchInputReceipt {
  readonly serverFrame: number;
  readonly selfStateHash: string;
  readonly acknowledgement: InputAcknowledgement;
}
