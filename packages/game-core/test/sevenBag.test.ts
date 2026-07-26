import assert from "node:assert/strict";
import test from "node:test";

import {
  PIECE_KINDS,
  createSharedSevenBag,
  ensureSharedSevenBag,
  readSharedSevenBagWindow
} from "../src/index.ts";
import type { PieceKind, SharedSevenBagState } from "../src/index.ts";

const SEED = [0x1234_5678, 0x9abc_def0, 0x0fed_cba9, 0x8765_4321] as const;

function read(
  state: SharedSevenBagState,
  start: number,
  count: number
): { readonly state: SharedSevenBagState; readonly pieces: readonly PieceKind[] } {
  return readSharedSevenBagWindow(state, start, count);
}

test("every generated bag contains each tetromino exactly once", () => {
  const state = ensureSharedSevenBag(createSharedSevenBag(SEED), 7 * 50);
  const generated = state.pieces;

  for (let offset = 0; offset < generated.length; offset += 7) {
    const bag = [...generated.slice(offset, offset + 7)].sort();
    assert.deepEqual(bag, [...PIECE_KINDS].sort());
  }
  assert.equal(state.bagsGenerated, 50);
});

test("both players receive the exact same bag permutations", () => {
  let shared = createSharedSevenBag(SEED);
  const cursors: [number, number] = [0, 0];
  const draws: [PieceKind[], PieceKind[]] = [[], []];
  const interleaving = [0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 0] as const;

  for (const player of interleaving) {
    const cursor = cursors[player];
    const window = read(shared, cursor, 1);
    shared = window.state;
    draws[player].push(window.pieces[0]!);
    cursors[player] = cursor + 1;
  }

  assert.deepEqual(draws[0], draws[1]);
  assert.deepEqual(draws[0], shared.pieces.slice(0, 7));
});

test("different consumption rates never reshuffle either player's queue", () => {
  let shared = createSharedSevenBag(SEED);
  const fast = read(shared, 0, 35);
  shared = fast.state;
  const slowFirstBag = read(shared, 0, 7);
  shared = slowFirstBag.state;
  const slowSecondBag = read(shared, 7, 7);

  assert.deepEqual(slowFirstBag.pieces, fast.pieces.slice(0, 7));
  assert.deepEqual(slowSecondBag.pieces, fast.pieces.slice(7, 14));
  assert.strictEqual(slowFirstBag.state, shared);
});

test("the same seed freezes the sequence across independent replays", () => {
  const first = read(createSharedSevenBag(SEED), 0, 70).pieces;
  const second = read(createSharedSevenBag([...SEED]), 0, 70).pieces;
  const different = read(
    createSharedSevenBag([SEED[0] ^ 1, SEED[1], SEED[2], SEED[3]]),
    0,
    70
  ).pieces;

  assert.deepEqual(first, second);
  assert.notDeepEqual(first, different);
});

test("invalid seeds and windows are rejected", () => {
  assert.throws(
    () => createSharedSevenBag([0, 0, 0, 0]),
    /not be all zero/
  );
  const state = createSharedSevenBag(SEED);
  assert.throws(() => read(state, -1, 1), /Invalid seven-bag window/);
  assert.throws(() => read(state, 0, 257), /Invalid seven-bag window/);
});
