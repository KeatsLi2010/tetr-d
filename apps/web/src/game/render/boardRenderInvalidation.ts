import type { ActivePiece, Board } from "@tetr-d/game-core";

export interface BoardVisualState {
  readonly board: Board;
  readonly active: ActivePiece | null;
  readonly visibleRows: number;
}

export interface BoardLayerDrawPlan {
  readonly staticLayer: boolean;
  readonly dynamicLayer: boolean;
}

function numberArraysEqual(
  left: readonly number[],
  right: readonly number[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function boardCellsEqual(left: Board, right: Board): boolean {
  if (left === right) return true;
  return (
    numberArraysEqual(left.rows, right.rows) &&
    left.garbageRows.length === right.garbageRows.length &&
    left.garbageRows.every(
      (value, index) => value === right.garbageRows[index]
    )
  );
}

export function activePiecesEqual(
  left: ActivePiece | null,
  right: ActivePiece | null
): boolean {
  if (left === right) return true;
  return (
    left !== null &&
    right !== null &&
    left.kind === right.kind &&
    left.rotation === right.rotation &&
    left.x === right.x &&
    left.y === right.y
  );
}

export function boardVisualStatesEqual(
  left: BoardVisualState,
  right: BoardVisualState
): boolean {
  return (
    left.visibleRows === right.visibleRows &&
    boardCellsEqual(left.board, right.board) &&
    activePiecesEqual(left.active, right.active)
  );
}

export function planBoardLayerDraw(
  previous: BoardVisualState | null,
  next: BoardVisualState
): BoardLayerDrawPlan {
  if (previous === null) {
    return { staticLayer: true, dynamicLayer: true };
  }
  const layoutChanged = previous.visibleRows !== next.visibleRows;
  const boardChanged = !boardCellsEqual(previous.board, next.board);
  return {
    staticLayer: layoutChanged || boardChanged,
    dynamicLayer:
      layoutChanged ||
      boardChanged ||
      !activePiecesEqual(previous.active, next.active)
  };
}
