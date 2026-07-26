import {
  boardAsPlayfield,
  isPiecePlacementValid,
  type Board
} from "./board.ts";
import { tryRotate } from "./rotation.ts";
import type {
  ActivePiece,
  PieceKind,
  RotationDirection
} from "./types.ts";

export type PieceGenerationBufferAction =
  | { readonly kind: "hold" }
  | { readonly kind: "rotate"; readonly direction: RotationDirection };

export interface PieceGenerationOptions {
  readonly board: Board;
  readonly incomingKind: PieceKind;
  readonly heldKind: PieceKind | null;
  readonly spawnX: number;
  readonly spawnY: number;
  readonly allowClutchLift: boolean;
  readonly allowBufferedHold: boolean;
  readonly canHoldWithoutBuffer: boolean;
  readonly drawNext: () => PieceKind;
}

export interface PieceGenerationResult {
  readonly active: ActivePiece | null;
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  readonly liftedRows: number;
  readonly usedIhs: boolean;
  readonly attemptedIrs: RotationDirection | null;
  readonly usedIrs: boolean;
  readonly irsKickIndex: number | null;
}

function placementAt(
  options: PieceGenerationOptions,
  kind: PieceKind,
  y: number,
  rotation: RotationDirection | null
): {
  readonly active: ActivePiece | null;
  readonly usedIrs: boolean;
  readonly irsKickIndex: number | null;
} {
  const base: ActivePiece = {
    kind,
    rotation: 0,
    x: options.spawnX,
    y
  };
  if (rotation !== null) {
    const rotated = tryRotate(
      boardAsPlayfield(options.board),
      base,
      rotation
    );
    if (rotated.success) {
      return {
        active: rotated.piece,
        usedIrs: true,
        irsKickIndex: rotated.kickIndex
      };
    }
  }
  return {
    active: isPiecePlacementValid(options.board, base) ? base : null,
    usedIrs: false,
    irsKickIndex: null
  };
}

function generatedPlacement(
  options: PieceGenerationOptions,
  kind: PieceKind,
  rotation: RotationDirection | null
): {
  readonly active: ActivePiece | null;
  readonly liftedRows: number;
  readonly usedIrs: boolean;
  readonly irsKickIndex: number | null;
} {
  const highestY = options.allowClutchLift
    ? options.board.rows.length - 1
    : options.spawnY;
  for (let y = options.spawnY; y <= highestY; y += 1) {
    const placement = placementAt(options, kind, y, rotation);
    if (placement.active !== null) {
      return { ...placement, liftedRows: y - options.spawnY };
    }
  }
  return {
    active: null,
    liftedRows: 0,
    usedIrs: false,
    irsKickIndex: null
  };
}

/** IHS chooses the kind before IRS; one generate consumes one buffer. */
export class PieceGenerationController {
  #hold = false;
  #rotation: RotationDirection | null = null;

  queue(action: PieceGenerationBufferAction): void {
    if (action.kind === "hold") this.#hold = true;
    else this.#rotation = action.direction;
  }

  clear(): void {
    this.#hold = false;
    this.#rotation = null;
  }

  generate(options: PieceGenerationOptions): PieceGenerationResult {
    const bufferedHold = this.#hold;
    const rotation = this.#rotation;
    this.clear();
    const usedIhs = bufferedHold && options.allowBufferedHold;
    const kind = usedIhs
      ? options.heldKind ?? options.drawNext()
      : options.incomingKind;
    const hold = usedIhs ? options.incomingKind : options.heldKind;
    const placement = generatedPlacement(options, kind, rotation);
    return Object.freeze({
      active: placement.active,
      hold,
      canHold: usedIhs ? false : options.canHoldWithoutBuffer,
      liftedRows: placement.liftedRows,
      usedIhs,
      attemptedIrs: rotation,
      usedIrs: placement.usedIrs,
      irsKickIndex: placement.irsKickIndex
    });
  }
}
