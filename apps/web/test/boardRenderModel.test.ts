import assert from "node:assert/strict";
import test from "node:test";

import { createBoard } from "@tetr-d/game-core";
import type { ActivePiece } from "@tetr-d/game-core";

import {
  buildBoardRenderModel,
  coreCellToScreen,
  findGhostPiece,
  lockedCellsForBoard,
  visibleCellsForPiece
} from "../src/game/render/boardRenderModel.ts";
import { previewCellsFor } from "../src/game/render/piecePreviewModel.ts";

test("core coordinates map upward y into top-down canvas rows", () => {
  assert.deepEqual(coreCellToScreen({ x: 0, y: 0 }), {
    column: 0,
    row: 19
  });
  assert.deepEqual(coreCellToScreen({ x: 9, y: 19 }), {
    column: 9,
    row: 0
  });
  assert.equal(coreCellToScreen({ x: 3, y: 20 }), null);
  assert.equal(coreCellToScreen({ x: -1, y: 2 }), null);
});

test("locked cells are neutral, garbage is marked, and hidden rows are cropped", () => {
  const board = createBoard(
    [1 << 0, 1 << 4, ...Array.from({ length: 18 }, () => 0), 1 << 9],
    [false, true]
  );

  assert.deepEqual(lockedCellsForBoard(board), [
    { column: 0, row: 19, source: "locked" },
    { column: 4, row: 18, source: "garbage" }
  ]);
});

test("ghost falls to the floor without changing piece identity or rotation", () => {
  const active: ActivePiece = {
    kind: "O",
    rotation: 0,
    x: 3,
    y: 18
  };
  const ghost = findGhostPiece(createBoard(), active);

  assert.deepEqual(ghost, {
    kind: "O",
    rotation: 0,
    x: 3,
    y: -1
  });
});

test("ghost stops above occupied board cells", () => {
  const active: ActivePiece = {
    kind: "O",
    rotation: 0,
    x: 3,
    y: 18
  };
  const blockerMask = (1 << 4) | (1 << 5);
  const ghost = findGhostPiece(createBoard([blockerMask]), active);

  assert.equal(ghost.y, 0);
});

test("active piece cells are individually cropped at the visible ceiling", () => {
  const active: ActivePiece = {
    kind: "O",
    rotation: 0,
    x: 3,
    y: 18
  };
  assert.deepEqual(visibleCellsForPiece(active, "active"), [
    { column: 4, row: 0, source: "active", piece: "O" },
    { column: 5, row: 0, source: "active", piece: "O" }
  ]);
});

test("danger render model reveals locked and active cells above row 20", () => {
  const rows = Array.from({ length: 21 }, () => 0);
  rows[17] = 1;
  rows[20] = 1 << 9;
  const model = buildBoardRenderModel({
    board: createBoard(rows),
    active: {
      kind: "O",
      rotation: 0,
      x: 3,
      y: 19
    }
  });

  assert.equal(model.visibleRows, 24);
  assert.ok(model.locked.some((cell) =>
    cell.column === 9 &&
    cell.row === 3
  ));
  assert.deepEqual(model.active, [
    { column: 4, row: 2, source: "active", piece: "O" },
    { column: 5, row: 2, source: "active", piece: "O" },
    { column: 4, row: 3, source: "active", piece: "O" },
    { column: 5, row: 3, source: "active", piece: "O" }
  ]);
});

test("piece previews stay centered in their four by four grid", () => {
  const oCells = previewCellsFor("O");
  assert.deepEqual(
    [...new Set(oCells.map((cell) => cell.column))].sort(),
    [2, 3]
  );
  assert.deepEqual(
    [...new Set(oCells.map((cell) => cell.row))].sort(),
    [2, 3]
  );

  const iCells = previewCellsFor("I");
  assert.deepEqual(
    iCells.map((cell) => cell.column).sort(),
    [1, 2, 3, 4]
  );
});
