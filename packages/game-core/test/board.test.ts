import assert from "node:assert/strict";
import test from "node:test";

import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  FULL_ROW_MASK,
  boardAsPlayfield,
  createBoard,
  hasBlocksAtOrAbove,
  insertGarbage,
  isBoardCellOccupied,
  isPerfectClear,
  isPieceLockedOut,
  isPiecePlacementValid,
  lockPiece,
  tryRotate
} from "../src/index.ts";

test("board rows are fixed, bottom-up, copied, and immutable", () => {
  const source = [0b1, 0b10];
  const board = createBoard(source);
  source[0] = 0;

  assert.equal(board.rows.length, BOARD_HEIGHT);
  assert.equal(board.garbageRows.length, BOARD_HEIGHT);
  assert.equal(isBoardCellOccupied(board, 0, 0), true);
  assert.equal(isBoardCellOccupied(board, 1, 1), true);
  assert.equal(Object.isFrozen(board.rows), true);
  assert.equal(Object.isFrozen(board), true);
  assert.equal(BOARD_WIDTH, 10);
});

test("board creation strictly rejects malformed masks and garbage flags", () => {
  assert.throws(() => createBoard([-1]), RangeError);
  assert.throws(() => createBoard([FULL_ROW_MASK + 1]), RangeError);
  assert.throws(() => createBoard([1.5]), RangeError);
  assert.throws(
    () => createBoard(Array.from({ length: BOARD_HEIGHT + 1 }, () => 0)),
    RangeError
  );
  assert.throws(() => createBoard([0], [true]), RangeError);
  assert.throws(() => createBoard([], [false]), RangeError);
});

test("placement detects occupied cells and every board boundary", () => {
  const board = createBoard([1 << 4]);

  assert.equal(
    isPiecePlacementValid(board, {
      kind: "T",
      rotation: 0,
      x: 3,
      y: -1
    }),
    false
  );
  assert.equal(
    isPiecePlacementValid(board, {
      kind: "I",
      rotation: 0,
      x: 5,
      y: -2
    }),
    true
  );
  assert.equal(
    isPiecePlacementValid(board, {
      kind: "I",
      rotation: 0,
      x: -1,
      y: -2
    }),
    false
  );
  assert.equal(
    isPiecePlacementValid(board, {
      kind: "I",
      rotation: 1,
      x: 3,
      y: 37
    }),
    false
  );
});

test("board playfield adapter participates in SRS+ collision checks", () => {
  const board = createBoard([0, 0, 0, 1 << 5]);
  const result = tryRotate(
    boardAsPlayfield(board),
    { kind: "T", rotation: 0, x: 4, y: 2 },
    "180"
  );

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.kickIndex, 2);
  }
});

test("locking clears four lines and reports a perfect clear", () => {
  const missingColumn = FULL_ROW_MASK ^ (1 << 5);
  const board = createBoard(
    [missingColumn, missingColumn, missingColumn, missingColumn],
    [true, false, true, false]
  );
  const result = lockPiece(board, {
    kind: "I",
    rotation: 1,
    x: 3,
    y: 0
  });

  assert.equal(result.clearedLineCount, 4);
  assert.equal(result.clearedGarbageLineCount, 2);
  assert.equal(result.clearedGarbage, true);
  assert.deepEqual(result.clearedRowIndices, [0, 1, 2, 3]);
  assert.equal(result.perfectClear, true);
  assert.equal(isPerfectClear(result.board), true);
  assert.equal(board.rows[0], missingColumn);
});

test("locking preserves garbage provenance on an uncleared row", () => {
  const board = createBoard([1], [true]);
  const result = lockPiece(board, {
    kind: "O",
    rotation: 0,
    x: 3,
    y: 0
  });

  assert.equal(result.clearedLineCount, 0);
  assert.equal(result.clearedGarbage, false);
  assert.equal(result.board.garbageRows[0], true);
  assert.equal(result.board.garbageRows[1], false);
  assert.throws(
    () =>
      lockPiece(board, {
        kind: "O",
        rotation: 0,
        x: -2,
        y: 0
      }),
    RangeError
  );
});

test("garbage inserts bottom-to-top, shifts provenance, and reports overflow", () => {
  const nearlyOverflowing = createBoard(
    [1, ...Array.from({ length: BOARD_HEIGHT - 2 }, () => 0), 1 << 2],
    [true]
  );
  const result = insertGarbage(nearlyOverflowing, [3, 7]);

  assert.equal(result.overflowed, true);
  assert.equal(result.board.rows[0], FULL_ROW_MASK ^ (1 << 3));
  assert.equal(result.board.rows[1], FULL_ROW_MASK ^ (1 << 7));
  assert.equal(result.board.rows[2], 1);
  assert.deepEqual(result.board.garbageRows.slice(0, 3), [
    true,
    true,
    true
  ]);
});

test("garbage insertion validates holes and a zero insert reuses the board", () => {
  const board = createBoard();

  assert.equal(insertGarbage(board, []).board, board);
  assert.throws(() => insertGarbage(board, [-1]), RangeError);
  assert.throws(() => insertGarbage(board, [BOARD_WIDTH]), RangeError);
  assert.throws(() => insertGarbage(board, [1.5]), RangeError);
});

test("top-out helpers distinguish danger height and full lock-out", () => {
  const board = createBoard([
    ...Array.from({ length: 20 }, () => 0),
    1
  ]);

  assert.equal(hasBlocksAtOrAbove(board, 20), true);
  assert.equal(hasBlocksAtOrAbove(board, 21), false);
  assert.equal(
    isPieceLockedOut({ kind: "O", rotation: 0, x: 3, y: 19 }),
    true
  );
  assert.equal(
    isPieceLockedOut({ kind: "O", rotation: 0, x: 3, y: 18 }),
    false
  );
});
