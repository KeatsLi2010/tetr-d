import {
  BOARD_HEIGHT,
  isPiecePlacementValid,
  type Board
} from "./board.ts";
import type { ActivePiece, PieceKind } from "./types.ts";

export interface PieceSpawnOptions {
  readonly board: Board;
  readonly kind: PieceKind;
  readonly spawnX: number;
  readonly spawnY: number;
  readonly allowClutchLift: boolean;
}

export interface PieceSpawnPlacement {
  readonly piece: ActivePiece;
  readonly liftedRows: number;
}

/**
 * Normal spawns only test the fixed four-mino footprint. After a line clear,
 * Clutch Clear may lift that footprint one row at a time to the lowest legal
 * position in the 40-row matrix.
 */
export function findPieceSpawnPlacement(
  options: PieceSpawnOptions
): PieceSpawnPlacement | null {
  const normal: ActivePiece = {
    kind: options.kind,
    rotation: 0,
    x: options.spawnX,
    y: options.spawnY
  };
  if (isPiecePlacementValid(options.board, normal)) {
    return { piece: normal, liftedRows: 0 };
  }
  if (!options.allowClutchLift) return null;

  for (let y = options.spawnY + 1; y < BOARD_HEIGHT; y += 1) {
    const piece: ActivePiece = { ...normal, y };
    if (isPiecePlacementValid(options.board, piece)) {
      return { piece, liftedRows: y - options.spawnY };
    }
  }
  return null;
}
