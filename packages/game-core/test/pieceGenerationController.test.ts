import assert from "node:assert/strict";
import test from "node:test";

import {
  PieceGenerationController,
  createBoard
} from "../src/index.ts";

const common = {
  spawnX: 3,
  spawnY: 0,
  allowClutchLift: false,
  allowBufferedHold: true,
  canHoldWithoutBuffer: true
} as const;

test("IHS runs before IRS and one generation consumes the buffer once", () => {
  const controller = new PieceGenerationController();
  controller.queue({ kind: "rotate", direction: "cw" });
  controller.queue({ kind: "hold" });
  const first = controller.generate({
    ...common,
    board: createBoard(),
    incomingKind: "T",
    heldKind: "L",
    drawNext: () => "Z"
  });

  assert.equal(first.usedIhs, true);
  assert.equal(first.active?.kind, "L");
  assert.equal(first.active?.rotation, 1);
  assert.equal(first.hold, "T");
  assert.equal(first.canHold, false);
  assert.equal(first.usedIrs, true);

  const second = controller.generate({
    ...common,
    board: createBoard(),
    incomingKind: "I",
    heldKind: first.hold,
    drawNext: () => "S"
  });
  assert.equal(second.usedIhs, false);
  assert.equal(second.active?.kind, "I");
  assert.equal(second.active?.rotation, 0);
  assert.equal(second.attemptedIrs, null);
});

test("IRS supports counter-clockwise and 180 degree rotations", () => {
  for (const [direction, rotation] of [
    ["ccw", 3],
    ["180", 2]
  ] as const) {
    const controller = new PieceGenerationController();
    controller.queue({ kind: "rotate", direction });
    const generated = controller.generate({
      ...common,
      board: createBoard(),
      incomingKind: "T",
      heldKind: null,
      drawNext: () => "I"
    });
    assert.equal(generated.active?.rotation, rotation);
    assert.equal(generated.usedIrs, true);
  }
});

test("failed IRS kicks fall back to a valid unrotated spawn", () => {
  const controller = new PieceGenerationController();
  controller.queue({ kind: "rotate", direction: "cw" });
  const generated = controller.generate({
    ...common,
    board: createBoard([
      (1 << 3) | (1 << 4),
      0,
      0,
      1 << 3
    ]),
    incomingKind: "T",
    heldKind: null,
    drawNext: () => "I"
  });

  assert.equal(generated.active?.kind, "T");
  assert.equal(generated.active?.rotation, 0);
  assert.equal(generated.attemptedIrs, "cw");
  assert.equal(generated.usedIrs, false);
});

test("IRS may rotate out before an invalid base spawn tops out", () => {
  const controller = new PieceGenerationController();
  controller.queue({ kind: "rotate", direction: "cw" });
  const generated = controller.generate({
    ...common,
    board: createBoard([0, 1 << 3]),
    incomingKind: "T",
    heldKind: null,
    drawNext: () => "I"
  });

  assert.equal(generated.active?.rotation, 1);
  assert.equal(generated.usedIrs, true);
});
