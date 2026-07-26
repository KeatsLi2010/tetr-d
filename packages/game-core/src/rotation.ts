import { worldCellsFor } from "./pieces.ts";
import { getKickTests, targetRotation } from "./srsPlus.ts";
import type {
  ActivePiece,
  Cell,
  Playfield,
  RotationDirection
} from "./types.ts";

export type RotationResult =
  | {
      readonly success: true;
      readonly piece: ActivePiece;
      readonly kick: Cell;
      readonly kickIndex: number;
    }
  | {
      readonly success: false;
      readonly piece: ActivePiece;
    };

export function isPlacementValid(
  playfield: Playfield,
  piece: ActivePiece
): boolean {
  if (!Number.isInteger(piece.x) || !Number.isInteger(piece.y)) {
    return false;
  }

  return worldCellsFor(
    piece.kind,
    piece.rotation,
    piece.x,
    piece.y
  ).every(
    (cell) =>
      cell.x >= 0 &&
      cell.x < playfield.width &&
      cell.y >= 0 &&
      cell.y < playfield.height &&
      !playfield.isOccupied(cell.x, cell.y)
  );
}

export function tryRotate(
  playfield: Playfield,
  piece: ActivePiece,
  direction: RotationDirection
): RotationResult {
  const rotation = targetRotation(piece.rotation, direction);
  const kicks = getKickTests(piece.kind, piece.rotation, direction);

  for (let kickIndex = 0; kickIndex < kicks.length; kickIndex += 1) {
    const kick = kicks[kickIndex];

    if (kick === undefined) {
      continue;
    }

    const candidate: ActivePiece = {
      ...piece,
      rotation,
      x: piece.x + kick.x,
      y: piece.y + kick.y
    };

    if (isPlacementValid(playfield, candidate)) {
      return {
        success: true,
        piece: candidate,
        kick,
        kickIndex
      };
    }
  }

  return {
    success: false,
    piece
  };
}

export function createPlayfield(
  occupied: readonly Cell[] = [],
  width = 10,
  height = 40
): Playfield {
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new RangeError(`Invalid playfield width: ${width}`);
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError(`Invalid playfield height: ${height}`);
  }

  for (const cell of occupied) {
    if (
      !Number.isSafeInteger(cell.x) ||
      !Number.isSafeInteger(cell.y) ||
      cell.x < 0 ||
      cell.x >= width ||
      cell.y < 0 ||
      cell.y >= height
    ) {
      throw new RangeError(`Invalid occupied cell: (${cell.x}, ${cell.y})`);
    }
  }

  const encoded = new Set(occupied.map((cell) => cell.y * width + cell.x));

  return {
    width,
    height,
    isOccupied(x: number, y: number): boolean {
      return encoded.has(y * width + x);
    }
  };
}
