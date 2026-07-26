import assert from "node:assert/strict";
import test from "node:test";

import { createBoard } from "@tetr-d/game-core";
import type { ActivePiece } from "@tetr-d/game-core";

import {
  BOARD_VIEWPORT_CONTRACT_MS,
  BOARD_VIEWPORT_EXPAND_MS,
  boardViewportDuration,
  boardViewportLayout,
  highestActiveRow,
  interpolateBoardVisibleRows,
  targetBoardVisibleRows
} from "../src/game/render/boardViewport.ts";

function boardWithTopRow(y: number) {
  const rows = Array.from({ length: y + 1 }, () => 0);
  rows[y] = 1;
  return createBoard(rows);
}

const highActive: ActivePiece = {
  kind: "T",
  rotation: 0,
  x: 3,
  y: 21
};

test("viewport remains at 20 rows outside the locked danger zone", () => {
  assert.equal(targetBoardVisibleRows({
    board: createBoard(),
    active: highActive
  }), 20);
  assert.equal(targetBoardVisibleRows({
    board: boardWithTopRow(16),
    active: null
  }), 20);
});

test("viewport progressively reveals the matrix with three rows of headroom", () => {
  for (const [highest, visible] of [
    [17, 21],
    [18, 22],
    [19, 23],
    [20, 24],
    [30, 34],
    [39, 40]
  ] as const) {
    assert.equal(targetBoardVisibleRows({
      board: boardWithTopRow(highest),
      active: null
    }), visible);
  }
});

test("danger camera also keeps an elevated Clutch piece visible", () => {
  assert.equal(highestActiveRow(highActive), 23);
  assert.equal(targetBoardVisibleRows({
    board: boardWithTopRow(17),
    active: highActive
  }), 24);
});

test("viewport layout zooms around a fixed floor and horizontal center", () => {
  assert.deepEqual(boardViewportLayout(200, 400, 20), {
    cell: 20,
    left: 0,
    top: 0,
    width: 200,
    height: 400,
    visibleRows: 20
  });

  const zoomed = boardViewportLayout(200, 400, 24);
  assert.ok(Math.abs(zoomed.cell - 400 / 24) < 1e-9);
  assert.ok(Math.abs(zoomed.width - 4000 / 24) < 1e-9);
  assert.ok(Math.abs(zoomed.left - (200 - zoomed.width) / 2) < 1e-9);
  assert.ok(Math.abs(zoomed.top + zoomed.height - 400) < 1e-9);
  assert.throws(() => boardViewportLayout(200, 400, 19), RangeError);
  assert.throws(() => boardViewportLayout(200, 400, 41), RangeError);
});

test("viewport animation is monotonic and uses asymmetric timing", () => {
  assert.equal(boardViewportDuration(20, 24), BOARD_VIEWPORT_EXPAND_MS);
  assert.equal(boardViewportDuration(24, 20), BOARD_VIEWPORT_CONTRACT_MS);
  const expanding = [0, 0.25, 0.5, 0.75, 1].map(
    (progress) => interpolateBoardVisibleRows(20, 24, progress)
  );
  const contracting = [0, 0.25, 0.5, 0.75, 1].map(
    (progress) => interpolateBoardVisibleRows(24, 20, progress)
  );

  assert.equal(expanding[0], 20);
  assert.equal(expanding.at(-1), 24);
  assert.equal(contracting[0], 24);
  assert.equal(contracting.at(-1), 20);
  assert.equal(
    expanding.every((value, index) =>
      index === 0 || value >= (expanding[index - 1] as number)
    ),
    true
  );
  assert.equal(
    contracting.every((value, index) =>
      index === 0 || value <= (contracting[index - 1] as number)
    ),
    true
  );
});
