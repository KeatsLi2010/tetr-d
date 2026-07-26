import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  VISIBLE_BOARD_HEIGHT,
  worldCellsFor
} from "@tetr-d/game-core";
import type {
  ActivePiece,
  Board,
  PlayerSimulationView
} from "@tetr-d/game-core";

export const BOARD_DANGER_START_ROW = 17;
export const BOARD_VIEWPORT_HEADROOM = 3;
export const BOARD_VIEWPORT_EXPAND_MS = 90;
export const BOARD_VIEWPORT_CONTRACT_MS = 180;

export interface BoardViewportLayout {
  readonly cell: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly visibleRows: number;
}

export function highestLockedRow(board: Board): number {
  const limit = Math.min(BOARD_HEIGHT, board.rows.length);
  for (let y = limit - 1; y >= 0; y -= 1) {
    if ((board.rows[y] ?? 0) !== 0) return y;
  }
  return -1;
}

export function highestActiveRow(active: ActivePiece | null): number {
  if (active === null) return -1;
  return Math.max(...worldCellsFor(
    active.kind,
    active.rotation,
    active.x,
    active.y
  ).map(({ y }) => y));
}

/**
 * The camera stays at 20 rows during ordinary play. Once the locked stack
 * reaches the danger zone it reveals enough of the 40-row matrix to keep the
 * stack and an elevated Clutch piece visible with a small amount of headroom.
 */
export function targetBoardVisibleRows(
  view: Pick<PlayerSimulationView, "board" | "active">
): number {
  const lockedTop = highestLockedRow(view.board);
  if (lockedTop < BOARD_DANGER_START_ROW) {
    return VISIBLE_BOARD_HEIGHT;
  }

  const required = Math.max(
    lockedTop + 1 + BOARD_VIEWPORT_HEADROOM,
    highestActiveRow(view.active) + 1
  );
  return Math.min(
    BOARD_HEIGHT,
    Math.max(VISIBLE_BOARD_HEIGHT, required)
  );
}

export function boardViewportLayout(
  width: number,
  height: number,
  visibleRows: number
): BoardViewportLayout {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(visibleRows) ||
    visibleRows < VISIBLE_BOARD_HEIGHT ||
    visibleRows > BOARD_HEIGHT
  ) {
    throw new RangeError("Invalid board viewport dimensions.");
  }
  const cell = Math.min(width / BOARD_WIDTH, height / visibleRows);
  const boardWidth = cell * BOARD_WIDTH;
  const boardHeight = cell * visibleRows;
  return {
    cell,
    left: (width - boardWidth) / 2,
    top: height - boardHeight,
    width: boardWidth,
    height: boardHeight,
    visibleRows
  };
}

export function boardViewportDuration(
  fromRows: number,
  toRows: number
): number {
  return toRows > fromRows
    ? BOARD_VIEWPORT_EXPAND_MS
    : BOARD_VIEWPORT_CONTRACT_MS;
}

export function interpolateBoardVisibleRows(
  fromRows: number,
  toRows: number,
  progress: number
): number {
  const normalized = Math.min(1, Math.max(0, progress));
  const eased = 1 - (1 - normalized) ** 3;
  return fromRows + (toRows - fromRows) * eased;
}
