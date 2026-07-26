import type { Board } from "./board.ts";
import type {
  BackToBackChargeState,
  SpinClassification
} from "./attackTypes.ts";
import type { SimulationGarbagePacket } from "./garbageQueue.ts";
import type { PlayerSimulationRules } from "./simulationRules.ts";
import type {
  ActivePiece,
  PieceKind,
  RotationDirection
} from "./types.ts";

export type SimulationInputAction =
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

export interface SimulationPieceSource {
  draw(): PieceKind;
  peek(count: number): readonly PieceKind[];
  getCursor(): number;
}

export interface PlayerLockSummary {
  readonly piece: PieceKind;
  readonly lines: number;
  readonly spin: SpinClassification;
  readonly combo: number;
  readonly backToBack: number;
  readonly perfectClear: boolean;
  readonly clearedGarbageLines: number;
  readonly cancelledGarbage: number;
  readonly outgoingAttacks: readonly number[];
  readonly appliedGarbageHoles: readonly number[];
}

export type PlayerPieceSpawnCause = "automatic" | "hardDrop" | "hold";

export interface PlayerPieceSpawnEvent {
  readonly cause: PlayerPieceSpawnCause;
  readonly piece: PieceKind;
  readonly liftedRows: number;
}

export interface PlayerFrameResult {
  readonly serverFrame: number;
  readonly locks: readonly PlayerLockSummary[];
  readonly spawns: readonly PlayerPieceSpawnEvent[];
  readonly outgoingAttacks: readonly number[];
  readonly newlyToppedOut: boolean;
  readonly toppedOut: boolean;
}

export interface PlayerSimulationView {
  readonly playerId: string;
  readonly rules: PlayerSimulationRules;
  readonly board: Board;
  readonly active: ActivePiece | null;
  readonly hold: PieceKind | null;
  readonly next: readonly PieceKind[];
  readonly pieceCursor: number;
  readonly combo: number;
  readonly backToBackState: BackToBackChargeState;
  readonly backToBack: number;
  readonly piecesPlaced: number;
  readonly totalAttackSent: number;
  readonly pendingGarbage: readonly SimulationGarbagePacket[];
  readonly heldInputMask: number;
  readonly dasFrames: number;
  readonly lockFrames: number;
  readonly lockResets: number;
  readonly canHold: boolean;
  readonly toppedOut: boolean;
}

export interface PlayerSimulationOptions {
  readonly playerId: string;
  readonly rules: PlayerSimulationRules;
  readonly pieces: SimulationPieceSource;
  /** Dedicated deterministic attack-rounding stream. */
  readonly nextAttackRoundingRoll: () => number;
  readonly initialBoard?: Board;
}
