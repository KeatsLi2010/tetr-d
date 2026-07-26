import assert from "node:assert/strict";
import test from "node:test";

import type { PieceKind, SevenBagSeed } from "@tetr-d/game-core";

import { LocalSevenBagPieceSource } from "../src/game/solo/LocalSevenBagPieceSource.ts";
import { createDeterministicAttackRng } from "../src/game/solo/attackRandom.ts";

const SEED: SevenBagSeed = [1, 2, 3, 4];

function draw(source: LocalSevenBagPieceSource, count: number): PieceKind[] {
  return Array.from({ length: count }, () => source.draw());
}

test("local seven-bag is deterministic and every bag contains all pieces", () => {
  const left = new LocalSevenBagPieceSource(SEED);
  const right = new LocalSevenBagPieceSource(SEED);
  const leftPieces = draw(left, 28);
  const rightPieces = draw(right, 28);

  assert.deepEqual(leftPieces, rightPieces);
  for (let start = 0; start < leftPieces.length; start += 7) {
    assert.deepEqual(
      [...new Set(leftPieces.slice(start, start + 7))].sort(),
      ["I", "J", "L", "O", "S", "T", "Z"]
    );
  }
});

test("peek does not consume pieces", () => {
  const source = new LocalSevenBagPieceSource(SEED);
  const preview = source.peek(14);

  assert.equal(source.getCursor(), 0);
  assert.deepEqual(draw(source, 14), preview);
  assert.equal(source.getCursor(), 14);
});

test("attack RNG is repeatable and independent from the piece stream", () => {
  const pieces = new LocalSevenBagPieceSource(SEED);
  const beforeRolls = pieces.peek(14);
  const left = createDeterministicAttackRng(SEED, 42);
  const right = createDeterministicAttackRng(SEED, 42);

  assert.deepEqual(
    Array.from({ length: 20 }, left),
    Array.from({ length: 20 }, right)
  );
  assert.deepEqual(pieces.peek(14), beforeRolls);
  assert.equal(pieces.getCursor(), 0);
});
