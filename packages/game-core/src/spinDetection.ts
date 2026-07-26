import { isPiecePlacementValid, type Board } from "./board.ts";
import type {
  ActivePiece,
  RotationDirection,
  RotationState
} from "./types.ts";
import type { SpinClassification } from "./attackTypes.ts";

export interface LastSuccessfulRotation {
  readonly direction: RotationDirection;
  readonly kickIndex: number;
}

function occupiedOrBoundary(board: Board, x: number, y: number): boolean {
  if (x < 0 || x >= 10 || y < 0 || y >= 40) return true;
  return ((board.rows[y] ?? 0) & (1 << x)) !== 0;
}

function frontOffsets(rotation: RotationState): readonly [number, number][] {
  switch (rotation) {
    case 0: return [[-1, 1], [1, 1]];
    case 1: return [[1, 1], [1, -1]];
    case 2: return [[-1, -1], [1, -1]];
    case 3: return [[-1, 1], [-1, -1]];
  }
}

function immobile(board: Board, piece: ActivePiece): boolean {
  return [
    { x: piece.x - 1, y: piece.y },
    { x: piece.x + 1, y: piece.y },
    { x: piece.x, y: piece.y - 1 },
    { x: piece.x, y: piece.y + 1 }
  ].every((position) =>
    !isPiecePlacementValid(board, { ...piece, ...position })
  );
}

/** Current All-Mini+ classification. The piece is tested before it is locked. */
export function classifyAllMiniPlusSpin(
  board: Board,
  piece: ActivePiece,
  lastRotation: LastSuccessfulRotation | null
): SpinClassification {
  if (lastRotation === null) return "none";
  if (piece.kind !== "T") return immobile(board, piece) ? "mini" : "none";

  const pivotX = piece.x + 1;
  const pivotY = piece.y + 1;
  const corners = [
    [-1, 1], [1, 1], [-1, -1], [1, -1]
  ] as const;
  const occupiedCorners = corners.filter(([dx, dy]) =>
    occupiedOrBoundary(board, pivotX + dx, pivotY + dy)
  ).length;
  if (occupiedCorners >= 3) {
    const occupiedFront = frontOffsets(piece.rotation).filter(([dx, dy]) =>
      occupiedOrBoundary(board, pivotX + dx, pivotY + dy)
    ).length;
    const fifth90Kick =
      lastRotation.direction !== "180" && lastRotation.kickIndex === 4;
    return occupiedFront === 2 || fifth90Kick ? "full" : "mini";
  }
  return immobile(board, piece) ? "mini" : "none";
}
