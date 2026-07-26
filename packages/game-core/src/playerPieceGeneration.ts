import type { Board } from "./board.ts";
import {
  PieceGenerationController,
  type PieceGenerationResult
} from "./pieceGenerationController.ts";
import type {
  PlayerPieceSpawnCause,
  SimulationInputAction,
  SimulationPieceSource
} from "./playerSimulationTypes.ts";
import type { PieceKind } from "./types.ts";

interface PendingGeneration {
  readonly incomingKind: PieceKind;
  readonly canHoldWithoutBuffer: boolean;
  readonly cause: PlayerPieceSpawnCause | null;
  readonly allowClutchLift: boolean;
  readonly allowBufferedHold: boolean;
}

export type GenerationInputDisposition =
  | "apply"
  | "buffered"
  | "finish";

export type FinishedPieceGeneration = PieceGenerationResult & {
  readonly cause: PlayerPieceSpawnCause | null;
};

export class PlayerPieceGeneration {
  readonly #controller = new PieceGenerationController();
  #pending: PendingGeneration | null = null;

  request(
    incomingKind: PieceKind,
    canHoldWithoutBuffer: boolean,
    cause: PlayerPieceSpawnCause | null,
    allowClutchLift: boolean,
    allowBufferedHold = false
  ): void {
    if (this.#pending !== null) {
      throw new Error("Piece generation is already pending.");
    }
    this.#pending = {
      incomingKind,
      canHoldWithoutBuffer,
      cause,
      allowClutchLift,
      allowBufferedHold
    };
  }

  consume(action: SimulationInputAction): GenerationInputDisposition {
    if (this.#pending === null) return "apply";
    if (action.kind === "hold" || action.kind === "rotate") {
      this.#controller.queue(action);
      return "buffered";
    }
    return "finish";
  }

  clearBuffer(): void {
    this.#controller.clear();
  }

  finish(options: {
    readonly board: Board;
    readonly heldKind: PieceKind | null;
    readonly spawnX: number;
    readonly spawnY: number;
    readonly pieces: SimulationPieceSource;
  }): FinishedPieceGeneration | null {
    const pending = this.#pending;
    if (pending === null) return null;
    this.#pending = null;
    const generated = this.#controller.generate({
      board: options.board,
      incomingKind: pending.incomingKind,
      heldKind: options.heldKind,
      spawnX: options.spawnX,
      spawnY: options.spawnY,
      allowClutchLift: pending.allowClutchLift,
      allowBufferedHold: pending.allowBufferedHold,
      canHoldWithoutBuffer: pending.canHoldWithoutBuffer,
      drawNext: () => options.pieces.draw()
    });
    return Object.freeze({ ...generated, cause: pending.cause });
  }
}
