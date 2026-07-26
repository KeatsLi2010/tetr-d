import type { SevenBagSeed } from "@tetr-d/game-core";

function mixSeed(seed: SevenBagSeed): number {
  let state = 0x9e37_79b9;
  for (const value of seed) {
    state ^= value;
    state = Math.imul(state ^ (state >>> 16), 0x85eb_ca6b);
    state = Math.imul(state ^ (state >>> 13), 0xc2b2_ae35);
    state ^= state >>> 16;
  }
  return state >>> 0 || 0x6d2b_79f5;
}

/** A dedicated stream: consuming attack rolls cannot alter the piece bag. */
export function createDeterministicAttackRng(
  pieceSeed: SevenBagSeed,
  attackSeed?: number
): () => number {
  let state = attackSeed ?? mixSeed(pieceSeed);
  if (!Number.isSafeInteger(state) || state < 0 || state > 0xffff_ffff) {
    throw new RangeError("Attack seed must be a uint32.");
  }
  state = state >>> 0 || 0x6d2b_79f5;

  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}
