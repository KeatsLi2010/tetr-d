export const PIECE_KINDS = ["I", "J", "L", "O", "S", "T", "Z"] as const;
export type PieceKind = (typeof PIECE_KINDS)[number];

/**
 * 0 = spawn, 1 = R, 2 = reverse, 3 = L.
 */
export type RotationState = 0 | 1 | 2 | 3;
export type RotationDirection = "cw" | "ccw" | "180";

/**
 * Game-core coordinates use +x to the right and +y upward.
 */
export interface Cell {
  readonly x: number;
  readonly y: number;
}

export interface ActivePiece {
  readonly kind: PieceKind;
  readonly rotation: RotationState;
  /**
   * World-space position of the piece's local 4×4 origin.
   */
  readonly x: number;
  readonly y: number;
}

export interface Playfield {
  readonly width: number;
  readonly height: number;
  isOccupied(x: number, y: number): boolean;
}

