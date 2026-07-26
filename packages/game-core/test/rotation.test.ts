import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlayfield,
  isPlacementValid,
  localCellsFor,
  tryRotate
} from "../src/index.ts";
import type { ActivePiece, Cell, PieceKind } from "../src/types.ts";

function normalized(cells: readonly Cell[]): readonly string[] {
  return cells.map((cell) => `${cell.x},${cell.y}`).sort();
}

test("every rotation state contains four unique cells", () => {
  const pieces: readonly PieceKind[] = ["I", "J", "L", "O", "S", "T", "Z"];

  for (const piece of pieces) {
    for (const rotation of [0, 1, 2, 3] as const) {
      assert.equal(new Set(normalized(localCellsFor(piece, rotation))).size, 4);
    }
  }
});

test("J and I use their specified SRS pivots", () => {
  assert.deepEqual(normalized(localCellsFor("J", 1)), [
    "1,0",
    "1,1",
    "1,2",
    "2,2"
  ]);
  assert.deepEqual(normalized(localCellsFor("I", 1)), [
    "2,0",
    "2,1",
    "2,2",
    "2,3"
  ]);
});

test("O geometry is invariant in all four orientation states", () => {
  const spawn = normalized(localCellsFor("O", 0));

  assert.deepEqual(normalized(localCellsFor("O", 1)), spawn);
  assert.deepEqual(normalized(localCellsFor("O", 2)), spawn);
  assert.deepEqual(normalized(localCellsFor("O", 3)), spawn);
});

test("an unobstructed T rotation accepts test zero", () => {
  const result = tryRotate(
    createPlayfield(),
    { kind: "T", rotation: 0, x: 3, y: 10 },
    "cw"
  );

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.kickIndex, 0);
    assert.deepEqual(result.kick, { x: 0, y: 0 });
    assert.equal(result.piece.rotation, 1);
  }
});

test("a blocked basic T rotation takes the first valid SRS kick", () => {
  const piece: ActivePiece = { kind: "T", rotation: 0, x: 7, y: 1 };
  const field = createPlayfield([{ x: 8, y: 1 }]);

  assert.equal(isPlacementValid(field, piece), true);

  const result = tryRotate(field, piece, "cw");
  assert.equal(result.success, true);

  if (result.success) {
    assert.equal(result.kickIndex, 1);
    assert.deepEqual(result.kick, { x: -1, y: 0 });
    assert.deepEqual(result.piece, {
      kind: "T",
      rotation: 1,
      x: 6,
      y: 1
    });
  }
});

test("a blocked basic 180° rotation takes the upward kick", () => {
  const piece: ActivePiece = { kind: "T", rotation: 0, x: 4, y: 2 };
  const result = tryRotate(
    createPlayfield([{ x: 5, y: 2 }]),
    piece,
    "180"
  );

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.kickIndex, 1);
    assert.deepEqual(result.kick, { x: 0, y: 1 });
    assert.equal(result.piece.rotation, 2);
  }
});

test("rotation fails atomically when every target is occupied", () => {
  const occupied: Cell[] = [];
  for (let y = 0; y < 40; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      occupied.push({ x, y });
    }
  }

  const piece: ActivePiece = { kind: "J", rotation: 0, x: 3, y: 10 };
  const result = tryRotate(createPlayfield(occupied), piece, "ccw");

  assert.deepEqual(result, { success: false, piece });
});

test("playfield rejects dimensions and occupied cells that could alias", () => {
  assert.throws(() => createPlayfield([], 0, 40), RangeError);
  assert.throws(() => createPlayfield([], 10, 1.5), RangeError);
  assert.throws(() => createPlayfield([{ x: 10, y: 0 }], 10, 40), RangeError);
  assert.throws(() => createPlayfield([{ x: 0.5, y: 1 }], 10, 40), RangeError);
});

test("fractional active-piece origins are never legal placements", () => {
  assert.equal(
    isPlacementValid(createPlayfield(), {
      kind: "T",
      rotation: 0,
      x: 3.5,
      y: 10
    }),
    false
  );
});
