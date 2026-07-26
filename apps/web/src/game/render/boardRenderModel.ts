import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  VISIBLE_BOARD_HEIGHT,
  isPiecePlacementValid,
  worldCellsFor
} from "@tetr-d/game-core";
import type {
  ActivePiece,
  Board,
  Cell,
  PieceKind,
  PlayerSimulationView
} from "@tetr-d/game-core";

import { targetBoardVisibleRows } from "./boardViewport.ts";

export interface ScreenCell {
  readonly column: number;
  readonly row: number;
}

export interface LockedRenderCell extends ScreenCell {
  readonly source: "locked" | "garbage";
}

export interface PieceRenderCell extends ScreenCell {
  readonly source: "active" | "ghost";
  readonly piece: PieceKind;
}

export interface BoardRenderModel {
  readonly visibleRows: number;
  readonly locked: readonly LockedRenderCell[];
  readonly ghost: readonly PieceRenderCell[];
  readonly active: readonly PieceRenderCell[];
}

export function coreCellToScreen(
  cell: Cell,
  visibleHeight = VISIBLE_BOARD_HEIGHT
): ScreenCell | null {
  if (
    cell.x < 0 ||
    cell.x >= BOARD_WIDTH ||
    cell.y < 0 ||
    cell.y >= visibleHeight
  ) {
    return null;
  }

  return {
    column: cell.x,
    row: visibleHeight - 1 - cell.y
  };
}

export function lockedCellsForBoard(
  board: Board,
  visibleHeight = VISIBLE_BOARD_HEIGHT
): readonly LockedRenderCell[] {
  const cells: LockedRenderCell[] = [];
  const rowCount = Math.min(
    visibleHeight,
    BOARD_HEIGHT,
    board.rows.length,
    board.garbageRows.length
  );

  for (let y = 0; y < rowCount; y += 1) {
    const mask = board.rows[y] ?? 0;
    const source = board.garbageRows[y] ? "garbage" : "locked";

    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      if ((mask & (1 << x)) === 0) continue;
      cells.push({
        column: x,
        row: visibleHeight - 1 - y,
        source
      });
    }
  }

  return cells;
}

export function visibleCellsForPiece(
  piece: ActivePiece,
  source: "active" | "ghost",
  visibleHeight = VISIBLE_BOARD_HEIGHT
): readonly PieceRenderCell[] {
  const visible: PieceRenderCell[] = [];

  for (const cell of worldCellsFor(
    piece.kind,
    piece.rotation,
    piece.x,
    piece.y
  )) {
    const screen = coreCellToScreen(cell, visibleHeight);
    if (screen === null) continue;
    visible.push({ ...screen, source, piece: piece.kind });
  }

  return visible;
}

/**
 * Rendering asks game-core whether each candidate placement is valid. It does
 * not reproduce collision or kick rules.
 */
export function findGhostPiece(
  board: Board,
  active: ActivePiece
): ActivePiece {
  let ghost = active;

  while (ghost.y > -BOARD_HEIGHT) {
    const candidate: ActivePiece = { ...ghost, y: ghost.y - 1 };
    if (!isPiecePlacementValid(board, candidate)) break;
    ghost = candidate;
  }

  return ghost;
}

export function buildBoardRenderModel(
  view: Pick<PlayerSimulationView, "board" | "active">
): BoardRenderModel {
  const visibleRows = targetBoardVisibleRows(view);
  const locked = lockedCellsForBoard(view.board, visibleRows);
  if (view.active === null) {
    return { visibleRows, locked, ghost: [], active: [] };
  }

  const ghostPiece = findGhostPiece(view.board, view.active);
  return {
    visibleRows,
    locked,
    ghost: visibleCellsForPiece(
      ghostPiece,
      "ghost",
      visibleRows
    ),
    active: visibleCellsForPiece(view.active, "active", visibleRows)
  };
}
