import { PIECE_KINDS } from "./types.ts";
import type { PieceKind } from "./types.ts";

export type SevenBagSeed = readonly [number, number, number, number];

export interface SharedSevenBagState {
  readonly randomState: SevenBagSeed;
  readonly pieces: readonly PieceKind[];
  readonly bagsGenerated: number;
}

export interface SevenBagWindow {
  readonly state: SharedSevenBagState;
  readonly pieces: readonly PieceKind[];
}

const UINT32_RANGE = 0x1_0000_0000;
const MAX_SEQUENCE_PIECES = 1_000_000;
const MAX_WINDOW_PIECES = 256;

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function validateSeed(seed: SevenBagSeed): void {
  if (
    seed.length !== 4 ||
    seed.some((value) => !isUint32(value)) ||
    seed.every((value) => value === 0)
  ) {
    throw new TypeError("Seven-bag seed must contain four uint32 values and not be all zero.");
  }
}

function rotateLeft(value: number, amount: number): number {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

function nextUint32(
  state: SevenBagSeed
): { readonly state: SevenBagSeed; readonly value: number } {
  const [s0, s1, s2, s3] = state;
  const value = Math.imul(rotateLeft(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
  const shifted = (s1 << 9) >>> 0;
  const next2 = (s2 ^ s0) >>> 0;
  const next3 = (s3 ^ s1) >>> 0;
  const next1 = (s1 ^ next2) >>> 0;
  const next0 = (s0 ^ next3) >>> 0;
  return {
    value,
    state: Object.freeze([
      next0,
      next1,
      (next2 ^ shifted) >>> 0,
      rotateLeft(next3, 11)
    ]) as SevenBagSeed
  };
}

function nextBounded(
  state: SevenBagSeed,
  exclusiveUpperBound: number
): { readonly state: SevenBagSeed; readonly value: number } {
  const limit =
    Math.floor(UINT32_RANGE / exclusiveUpperBound) * exclusiveUpperBound;
  let current = state;
  while (true) {
    const generated = nextUint32(current);
    current = generated.state;
    if (generated.value < limit) {
      return {
        state: current,
        value: generated.value % exclusiveUpperBound
      };
    }
  }
}

function generateBag(
  state: SevenBagSeed
): { readonly state: SevenBagSeed; readonly bag: readonly PieceKind[] } {
  const bag = [...PIECE_KINDS];
  let current = state;
  for (let index = bag.length - 1; index > 0; index -= 1) {
    const generated = nextBounded(current, index + 1);
    current = generated.state;
    const swap = bag[index]!;
    bag[index] = bag[generated.value]!;
    bag[generated.value] = swap;
  }
  return { state: current, bag: Object.freeze(bag) };
}

export function createSharedSevenBag(seed: SevenBagSeed): SharedSevenBagState {
  validateSeed(seed);
  return Object.freeze({
    randomState: Object.freeze([...seed]) as SevenBagSeed,
    pieces: Object.freeze([]),
    bagsGenerated: 0
  });
}

export function ensureSharedSevenBag(
  state: SharedSevenBagState,
  minimumPieceCount: number
): SharedSevenBagState {
  if (
    !Number.isSafeInteger(minimumPieceCount) ||
    minimumPieceCount < 0 ||
    minimumPieceCount > MAX_SEQUENCE_PIECES
  ) {
    throw new RangeError("Invalid seven-bag sequence length.");
  }
  if (state.pieces.length >= minimumPieceCount) return state;

  let randomState = state.randomState;
  const pieces = [...state.pieces];
  let bagsGenerated = state.bagsGenerated;
  while (pieces.length < minimumPieceCount) {
    const generated = generateBag(randomState);
    randomState = generated.state;
    pieces.push(...generated.bag);
    bagsGenerated += 1;
  }
  return Object.freeze({
    randomState,
    pieces: Object.freeze(pieces),
    bagsGenerated
  });
}

export function readSharedSevenBagWindow(
  state: SharedSevenBagState,
  startIndex: number,
  count: number
): SevenBagWindow {
  if (
    !Number.isSafeInteger(startIndex) ||
    startIndex < 0 ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > MAX_WINDOW_PIECES
  ) {
    throw new RangeError("Invalid seven-bag window.");
  }
  const required = startIndex + count;
  if (!Number.isSafeInteger(required) || required > MAX_SEQUENCE_PIECES) {
    throw new RangeError("Seven-bag window exceeds sequence capacity.");
  }
  const nextState = ensureSharedSevenBag(state, required);
  return {
    state: nextState,
    pieces: Object.freeze(nextState.pieces.slice(startIndex, required))
  };
}
