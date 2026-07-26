import { randomBytes } from "node:crypto";

export interface MatchRandomSeeds {
  readonly firstAttack: number;
  readonly secondAttack: number;
  readonly garbageHole: number;
}

function validateSeed(seed: number): number {
  if (!Number.isInteger(seed) || seed < 1 || seed > 0xffff_ffff) {
    throw new RangeError("Match random seed must be a non-zero uint32.");
  }
  return seed >>> 0;
}

export function createMatchRandomSeeds(): MatchRandomSeeds {
  const bytes = randomBytes(12);
  const read = (offset: number): number => {
    const value = bytes.readUInt32LE(offset);
    return value === 0 ? 0x9e37_79b9 ^ offset : value;
  };
  return Object.freeze({
    firstAttack: read(0),
    secondAttack: read(4),
    garbageHole: read(8)
  });
}

export class MatchRandomStream {
  #state: number;

  constructor(seed: number) {
    this.#state = validateSeed(seed);
  }

  nextUint32(): number {
    let value = this.#state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.#state = value >>> 0;
    return this.#state;
  }

  nextFloat(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  nextInteger(exclusiveUpperBound: number): number {
    if (!Number.isSafeInteger(exclusiveUpperBound) || exclusiveUpperBound < 1) {
      throw new RangeError("Invalid match random upper bound.");
    }
    const limit =
      Math.floor(0x1_0000_0000 / exclusiveUpperBound) * exclusiveUpperBound;
    while (true) {
      const value = this.nextUint32();
      if (value < limit) return value % exclusiveUpperBound;
    }
  }
}
