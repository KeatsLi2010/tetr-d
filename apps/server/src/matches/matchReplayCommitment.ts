import {
  createHash,
  timingSafeEqual
} from "node:crypto";

import type { MatchRandomSeeds } from "./matchRandom.ts";

const MATCH_RANDOM_COMMITMENT_DOMAIN =
  "tetr-d/match-random-seeds/v1";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface MatchRandomCommitmentContext {
  readonly matchId: string;
  readonly rulesetVersion: string;
  readonly seeds: MatchRandomSeeds;
}

function validateContext(value: string, name: string): void {
  if (
    value.length < 1
    || value.length > 128
    || value.includes("\0")
  ) {
    throw new TypeError(`Invalid replay ${name}.`);
  }
}

function seedBytes(seeds: MatchRandomSeeds): Buffer {
  const values = [
    seeds.firstAttack,
    seeds.secondAttack,
    seeds.garbageHole
  ];
  if (
    values.some((value) =>
      !Number.isInteger(value)
      || value < 1
      || value > 0xffff_ffff
    )
  ) {
    throw new RangeError("Replay random seeds must be non-zero uint32 values.");
  }
  const bytes = Buffer.allocUnsafe(12);
  values.forEach((value, index) => {
    bytes.writeUInt32LE(value, index * 4);
  });
  return bytes;
}

export function createMatchRandomSeedCommitment(
  context: MatchRandomCommitmentContext
): string {
  validateContext(context.matchId, "matchId");
  validateContext(context.rulesetVersion, "rulesetVersion");
  return createHash("sha256")
    .update(MATCH_RANDOM_COMMITMENT_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(context.matchId, "utf8")
    .update("\0", "utf8")
    .update(context.rulesetVersion, "utf8")
    .update("\0", "utf8")
    .update(seedBytes(context.seeds))
    .digest("hex");
}

export function verifyMatchRandomSeedReveal(
  commitment: string,
  context: MatchRandomCommitmentContext
): boolean {
  if (!HASH_PATTERN.test(commitment)) return false;
  let expected: string;
  try {
    expected = createMatchRandomSeedCommitment(context);
  } catch {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(commitment, "hex"),
    Buffer.from(expected, "hex")
  );
}
