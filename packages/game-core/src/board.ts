import { worldCellsFor } from "./pieces.ts";
import { PIECE_KINDS } from "./types.ts";
import type { ActivePiece, Playfield } from "./types.ts";

export const BOARD_WIDTH = 10;
export const BOARD_HEIGHT = 40;
export const VISIBLE_BOARD_HEIGHT = 20;
export const FULL_ROW_MASK = (1 << BOARD_WIDTH) - 1;

/**
 * Rows use bit x for column x and are stored bottom-up: rows[0] is the floor.
 * garbageRows travels with its row until that row is cleared.
 */
export interface Board {
  readonly rows: readonly number[];
  readonly garbageRows: readonly boolean[];
}

export interface LockPieceResult {
  readonly board: Board;
  readonly clearedLineCount: number;
  readonly clearedGarbageLineCount: number;
  readonly clearedGarbage: boolean;
  readonly clearedRowIndices: readonly number[];
  readonly perfectClear: boolean;
}

export interface GarbageInsertResult {
  readonly board: Board;
  /** True when at least one occupied top row was pushed outside the board. */
  readonly overflowed: boolean;
}

const PIECE_KIND_SET = new Set<string>(PIECE_KINDS);

function assertRowMask(row: number, index: number): void {
  if (!Number.isSafeInteger(row) || row < 0 || row > FULL_ROW_MASK) {
    throw new RangeError(`Invalid row mask at ${index}: ${row}`);
  }
}

function assertBoard(board: Board): void {
  if (typeof board !== "object" || board === null) {
    throw new TypeError("Board must be an object");
  }
  if (
    !Array.isArray(board.rows) ||
    !Array.isArray(board.garbageRows) ||
    board.rows.length !== BOARD_HEIGHT ||
    board.garbageRows.length !== BOARD_HEIGHT
  ) {
    throw new RangeError(`Board must contain exactly ${BOARD_HEIGHT} rows`);
  }

  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    const row = board.rows[y];
    const isGarbage = board.garbageRows[y];
    assertRowMask(row as number, y);
    if (typeof isGarbage !== "boolean") {
      throw new TypeError(`Invalid garbage row flag at ${y}`);
    }
    if (isGarbage && row === 0) {
      throw new RangeError(`Empty row ${y} cannot be marked as garbage`);
    }
  }
}

function assertPiece(piece: ActivePiece): void {
  if (typeof piece !== "object" || piece === null) {
    throw new TypeError("Active piece must be an object");
  }
  if (!PIECE_KIND_SET.has(piece.kind)) {
    throw new RangeError(`Invalid piece kind: ${piece.kind}`);
  }
  if (
    piece.rotation !== 0 &&
    piece.rotation !== 1 &&
    piece.rotation !== 2 &&
    piece.rotation !== 3
  ) {
    throw new RangeError(`Invalid rotation state: ${piece.rotation}`);
  }
  if (!Number.isSafeInteger(piece.x) || !Number.isSafeInteger(piece.y)) {
    throw new RangeError("Piece origin must use safe integers");
  }
}

function assertCellCoordinate(x: number, y: number): void {
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    x < 0 ||
    x >= BOARD_WIDTH ||
    y < 0 ||
    y >= BOARD_HEIGHT
  ) {
    throw new RangeError(`Invalid board cell: (${x}, ${y})`);
  }
}

function makeBoard(rows: number[], garbageRows: boolean[]): Board {
  Object.freeze(rows);
  Object.freeze(garbageRows);
  return Object.freeze({ rows, garbageRows });
}

/**
 * Creates a fixed 10x40 board. Both inputs are bottom-up and may omit empty
 * top rows. A true garbage flag must refer to a supplied, occupied row.
 */
export function createBoard(
  rows: readonly number[] = [],
  garbageRows: readonly boolean[] = []
): Board {
  if (!Array.isArray(rows) || !Array.isArray(garbageRows)) {
    throw new TypeError("Board rows and garbage flags must be arrays");
  }
  if (rows.length > BOARD_HEIGHT || garbageRows.length > rows.length) {
    throw new RangeError(`Board cannot exceed ${BOARD_HEIGHT} rows`);
  }

  const normalizedRows = Array.from(
    { length: BOARD_HEIGHT },
    (_, y) => rows[y] ?? 0
  );
  const normalizedGarbage = Array.from(
    { length: BOARD_HEIGHT },
    (_, y) => garbageRows[y] ?? false
  );

  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    const row = normalizedRows[y] as number;
    assertRowMask(row, y);
    if (typeof normalizedGarbage[y] !== "boolean") {
      throw new TypeError(`Invalid garbage row flag at ${y}`);
    }
    if (normalizedGarbage[y] && row === 0) {
      throw new RangeError(`Empty row ${y} cannot be marked as garbage`);
    }
  }

  return makeBoard(normalizedRows, normalizedGarbage);
}

export function isBoardCellOccupied(
  board: Board,
  x: number,
  y: number
): boolean {
  assertBoard(board);
  assertCellCoordinate(x, y);
  return ((board.rows[y] as number) & (1 << x)) !== 0;
}

export function boardAsPlayfield(board: Board): Playfield {
  assertBoard(board);
  return {
    width: BOARD_WIDTH,
    height: BOARD_HEIGHT,
    isOccupied(x: number, y: number): boolean {
      return isBoardCellOccupied(board, x, y);
    }
  };
}

export function isPiecePlacementValid(
  board: Board,
  piece: ActivePiece
): boolean {
  assertBoard(board);
  assertPiece(piece);

  return worldCellsFor(
    piece.kind,
    piece.rotation,
    piece.x,
    piece.y
  ).every(
    ({ x, y }) =>
      x >= 0 &&
      x < BOARD_WIDTH &&
      y >= 0 &&
      y < BOARD_HEIGHT &&
      (((board.rows[y] as number) & (1 << x)) === 0)
  );
}

export function lockPiece(
  board: Board,
  piece: ActivePiece
): LockPieceResult {
  if (!isPiecePlacementValid(board, piece)) {
    throw new RangeError("Cannot lock a colliding or out-of-bounds piece");
  }

  const lockedRows = [...board.rows];
  const lockedGarbage = [...board.garbageRows];
  for (const { x, y } of worldCellsFor(
    piece.kind,
    piece.rotation,
    piece.x,
    piece.y
  )) {
    lockedRows[y] = (lockedRows[y] as number) | (1 << x);
  }

  const remainingRows: number[] = [];
  const remainingGarbage: boolean[] = [];
  const clearedRowIndices: number[] = [];
  let clearedGarbageLineCount = 0;

  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    if (lockedRows[y] === FULL_ROW_MASK) {
      clearedRowIndices.push(y);
      if (lockedGarbage[y]) {
        clearedGarbageLineCount += 1;
      }
    } else {
      remainingRows.push(lockedRows[y] as number);
      remainingGarbage.push(lockedGarbage[y] as boolean);
    }
  }

  while (remainingRows.length < BOARD_HEIGHT) {
    remainingRows.push(0);
    remainingGarbage.push(false);
  }

  const nextBoard = makeBoard(remainingRows, remainingGarbage);
  Object.freeze(clearedRowIndices);
  return {
    board: nextBoard,
    clearedLineCount: clearedRowIndices.length,
    clearedGarbageLineCount,
    clearedGarbage: clearedGarbageLineCount > 0,
    clearedRowIndices,
    perfectClear: isPerfectClear(nextBoard)
  };
}

/**
 * Inserts garbage rows at the floor. holesBottomToTop[0] describes row 0
 * after insertion; existing rows move upward without changing their flags.
 */
export function insertGarbage(
  board: Board,
  holesBottomToTop: readonly number[]
): GarbageInsertResult {
  assertBoard(board);
  if (!Array.isArray(holesBottomToTop)) {
    throw new TypeError("Garbage holes must be an array");
  }
  if (holesBottomToTop.length > BOARD_HEIGHT) {
    throw new RangeError(`Cannot insert more than ${BOARD_HEIGHT} rows`);
  }

  for (const hole of holesBottomToTop) {
    if (!Number.isSafeInteger(hole) || hole < 0 || hole >= BOARD_WIDTH) {
      throw new RangeError(`Invalid garbage hole: ${hole}`);
    }
  }

  const count = holesBottomToTop.length;
  if (count === 0) {
    return { board, overflowed: false };
  }

  const overflowed = board.rows
    .slice(BOARD_HEIGHT - count)
    .some((row) => row !== 0);
  const garbageRows = holesBottomToTop.map(
    (hole) => FULL_ROW_MASK ^ (1 << hole)
  );
  const rows = [...garbageRows, ...board.rows.slice(0, BOARD_HEIGHT - count)];
  const flags = [
    ...Array.from({ length: count }, () => true),
    ...board.garbageRows.slice(0, BOARD_HEIGHT - count)
  ];

  return {
    board: makeBoard(rows, flags),
    overflowed
  };
}

export function isPerfectClear(board: Board): boolean {
  assertBoard(board);
  return board.rows.every((row) => row === 0);
}

export function hasBlocksAtOrAbove(board: Board, y: number): boolean {
  assertBoard(board);
  if (!Number.isSafeInteger(y) || y < 0 || y > BOARD_HEIGHT) {
    throw new RangeError(`Invalid board row threshold: ${y}`);
  }
  return board.rows.slice(y).some((row) => row !== 0);
}

export function isPieceLockedOut(
  piece: ActivePiece,
  visibleHeight = VISIBLE_BOARD_HEIGHT
): boolean {
  assertPiece(piece);
  if (
    !Number.isSafeInteger(visibleHeight) ||
    visibleHeight < 0 ||
    visibleHeight > BOARD_HEIGHT
  ) {
    throw new RangeError(`Invalid visible height: ${visibleHeight}`);
  }
  return worldCellsFor(
    piece.kind,
    piece.rotation,
    piece.x,
    piece.y
  ).every(({ y }) => y >= visibleHeight);
}
