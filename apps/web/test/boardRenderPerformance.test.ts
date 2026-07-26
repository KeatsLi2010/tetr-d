import assert from "node:assert/strict";
import test from "node:test";

import { createBoard } from "@tetr-d/game-core";
import type { ActivePiece } from "@tetr-d/game-core";

import {
  boardCellsEqual,
  planBoardLayerDraw,
  type BoardVisualState
} from "../src/game/render/boardRenderInvalidation.ts";

function visual(
  active: ActivePiece | null,
  visibleRows = 20
): BoardVisualState {
  return {
    board: createBoard([0b11, 0b101, 0b111]),
    active,
    visibleRows
  };
}

test("240 equivalent network boards cause one static and one dynamic draw", () => {
  let previous: BoardVisualState | null = null;
  let staticDraws = 0;
  let dynamicDraws = 0;
  const active: ActivePiece = {
    kind: "T",
    rotation: 0,
    x: 3,
    y: 17
  };

  for (let snapshot = 0; snapshot < 240; snapshot += 1) {
    const next = visual({ ...active });
    const plan = planBoardLayerDraw(previous, next);
    if (plan.staticLayer) staticDraws += 1;
    if (plan.dynamicLayer) dynamicDraws += 1;
    previous = next;
  }

  assert.deepEqual({ staticDraws, dynamicDraws }, {
    staticDraws: 1,
    dynamicDraws: 1
  });
});

test("active movement redraws only the dynamic layer", () => {
  let previous: BoardVisualState | null = null;
  let staticDraws = 0;
  let dynamicDraws = 0;

  for (let frame = 0; frame < 60; frame += 1) {
    const next = visual({
      kind: "I",
      rotation: 0,
      x: frame,
      y: 17
    });
    const plan = planBoardLayerDraw(previous, next);
    if (plan.staticLayer) staticDraws += 1;
    if (plan.dynamicLayer) dynamicDraws += 1;
    previous = next;
  }

  assert.deepEqual({ staticDraws, dynamicDraws }, {
    staticDraws: 1,
    dynamicDraws: 60
  });
});

test("board and camera changes invalidate both canvas layers", () => {
  const active: ActivePiece = {
    kind: "O",
    rotation: 0,
    x: 3,
    y: 17
  };
  const initial = visual(active);
  const boardChanged: BoardVisualState = {
    ...initial,
    board: createBoard([0b11, 0b101, 0b111, 0b1])
  };
  const cameraChanged = { ...boardChanged, visibleRows: 23 };

  assert.equal(boardCellsEqual(initial.board, visual(active).board), true);
  assert.deepEqual(planBoardLayerDraw(initial, boardChanged), {
    staticLayer: true,
    dynamicLayer: true
  });
  assert.deepEqual(planBoardLayerDraw(boardChanged, cameraChanged), {
    staticLayer: true,
    dynamicLayer: true
  });
});
