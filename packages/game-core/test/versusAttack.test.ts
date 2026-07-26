import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_BACK_TO_BACK_CHARGE_STATE,
  VERSUS_ATTACK_RULESET_VERSION,
  backToBackChargeStatus,
  openerCancellationMultiplier,
  resolveVersusAttack,
  roundVersusAttack,
  splitSurgeAttack
} from "../src/index.ts";
import type {
  BackToBackChargeState,
  VersusAttackEvent,
  VersusAttackRoundingOptions
} from "../src/index.ts";

interface AttackVector {
  readonly name: string;
  readonly event: VersusAttackEvent;
  readonly streak?: number;
  readonly roll?: number;
  readonly attack: number;
}

const vectors: readonly AttackVector[] = [
  {
    name: "single at combo zero",
    event: { lines: 1, spin: "none", combo: 0 },
    attack: 0
  },
  {
    name: "double",
    event: { lines: 2, spin: "none", combo: 0 },
    attack: 1
  },
  {
    name: "triple",
    event: { lines: 3, spin: "none", combo: 0 },
    attack: 2
  },
  {
    name: "quad",
    event: { lines: 4, spin: "none", combo: 0 },
    attack: 4
  },
  {
    name: "full spin single",
    event: { lines: 1, spin: "full", combo: 0 },
    attack: 2
  },
  {
    name: "full spin double",
    event: { lines: 2, spin: "full", combo: 0 },
    attack: 4
  },
  {
    name: "full spin triple",
    event: { lines: 3, spin: "full", combo: 0 },
    attack: 6
  },
  {
    name: "mini single starts B2B but has zero base",
    event: { lines: 1, spin: "mini", combo: 0 },
    attack: 0
  },
  {
    name: "mini double uses the normal base row",
    event: { lines: 2, spin: "mini", combo: 0 },
    attack: 1
  },
  {
    name: "zero-base combo two uses logarithmic padding",
    event: { lines: 1, spin: "none", combo: 2 },
    roll: 0.99,
    attack: 1
  },
  {
    name: "zero-base combo six reaches two attack",
    event: { lines: 1, spin: "none", combo: 6 },
    roll: 0.99,
    attack: 2
  },
  {
    name: "double combo three rounds down for a high RNG roll",
    event: { lines: 2, spin: "none", combo: 3 },
    roll: 0.99,
    attack: 1
  },
  {
    name: "quad combo one",
    event: { lines: 4, spin: "none", combo: 1 },
    attack: 5
  },
  {
    name: "B2B full spin double",
    event: { lines: 2, spin: "full", combo: 0 },
    streak: 1,
    attack: 5
  },
  {
    name: "B2B full spin double combo one",
    event: { lines: 2, spin: "full", combo: 1 },
    streak: 1,
    roll: 0.99,
    attack: 6
  },
  {
    name: "B2B mini single sends its B2B point",
    event: { lines: 1, spin: "mini", combo: 0 },
    streak: 1,
    attack: 1
  },
  {
    name: "quad all clear adds five and starts B2B",
    event: { lines: 4, spin: "none", combo: 0, allClear: true },
    attack: 9
  },
  {
    name: "garbage-clearing quad adds a flat one",
    event: {
      lines: 4,
      spin: "none",
      combo: 0,
      clearedGarbage: true
    },
    attack: 5
  },
  {
    name: "garbage-clearing B2B spin adds after RNG rounding",
    event: {
      lines: 2,
      spin: "full",
      combo: 1,
      clearedGarbage: true
    },
    streak: 1,
    roll: 0.99,
    attack: 7
  }
];

for (const vector of vectors) {
  test(`attack vector: ${vector.name}`, () => {
    const state: BackToBackChargeState = {
      difficultClearStreak: vector.streak ?? 0
    };
    const options: VersusAttackRoundingOptions =
      vector.roll === undefined ? {} : { roundingRoll: vector.roll };
    const result = resolveVersusAttack(vector.event, state, options);

    assert.equal(result.rulesetVersion, VERSUS_ATTACK_RULESET_VERSION);
    assert.equal(result.roundingMode, "rng");
    assert.equal(result.clearAttack, vector.attack);
  });
}

test("current TL profile uses deterministic weighted RNG rounding", () => {
  const event: VersusAttackEvent = {
    lines: 2,
    spin: "none",
    combo: 1
  };

  const roundedUp = resolveVersusAttack(event, undefined, {
    roundingRoll: 0.2
  });
  const roundedDown = resolveVersusAttack(event, undefined, {
    roundingRoll: 0.3
  });

  assert.equal(roundedUp.scaledAttackBeforeRounding, 1.25);
  assert.equal(roundedUp.roundingMode, "rng");
  assert.equal(roundedUp.clearAttack, 2);
  assert.equal(roundedDown.clearAttack, 1);
});

test("rounding helper handles probability and explicit DOWN mode", () => {
  assert.equal(roundVersusAttack(2.6, "rng", 0.59), 3);
  assert.equal(roundVersusAttack(2.6, "rng", 0.61), 2);
  assert.equal(roundVersusAttack(2.25, "rng", 0.249999), 3);
  assert.equal(roundVersusAttack(2.25, "rng", 0.25), 2);
  assert.equal(roundVersusAttack(2.99, "down"), 2);
});

test("B2B x4 starts Surge at four and breaking sends three packets", () => {
  let state = INITIAL_BACK_TO_BACK_CHARGE_STATE;
  const difficultEvents: readonly VersusAttackEvent[] = [
    { lines: 4, spin: "none", combo: 0 },
    { lines: 2, spin: "full", combo: 0 },
    { lines: 1, spin: "mini", combo: 0 },
    { lines: 3, spin: "full", combo: 0 },
    { lines: 4, spin: "none", combo: 0 }
  ];
  const expectedAttack = [4, 5, 1, 7, 5];
  const expectedDisplayed = [0, 1, 2, 3, 4];

  difficultEvents.forEach((event, index) => {
    const result = resolveVersusAttack(event, state);
    assert.equal(result.clearAttack, expectedAttack[index]);
    assert.equal(
      result.nextBackToBackStatus.displayedCount,
      expectedDisplayed[index]
    );
    state = result.nextBackToBack;
  });

  assert.deepEqual(backToBackChargeStatus(state), {
    displayedCount: 4,
    surgeCharge: 4
  });

  const broken = resolveVersusAttack(
    { lines: 2, spin: "none", combo: 0 },
    state
  );
  assert.equal(broken.clearAttack, 1);
  assert.deepEqual(broken.surgePackets, [2, 1, 1]);
  assert.deepEqual(
    broken.nextBackToBack,
    INITIAL_BACK_TO_BACK_CHARGE_STATE
  );
});

test("Surge remainder is assigned to the first and then second packet", () => {
  assert.deepEqual(splitSurgeAttack(4), [2, 1, 1]);
  assert.deepEqual(splitSurgeAttack(5), [2, 2, 1]);
  assert.deepEqual(splitSurgeAttack(6), [2, 2, 2]);
  assert.deepEqual(splitSurgeAttack(8), [3, 3, 2]);
});

test("all clear is difficult even when its line clear otherwise is not", () => {
  const result = resolveVersusAttack({
    lines: 1,
    spin: "none",
    combo: 0,
    allClear: true
  });

  assert.equal(result.difficult, true);
  assert.equal(result.clearAttack, 5);
  assert.equal(result.nextBackToBack.difficultClearStreak, 1);
});

test("non-difficult clear below Surge threshold breaks without packets", () => {
  const result = resolveVersusAttack(
    { lines: 3, spin: "none", combo: 0 },
    { difficultClearStreak: 4 }
  );

  assert.deepEqual(result.surgePackets, []);
  assert.equal(result.nextBackToBack.difficultClearStreak, 0);
});

test("opener helper exposes eligibility without guessing consumption", () => {
  assert.equal(
    openerCancellationMultiplier({
      piecesPlacedBeforeLock: 13,
      pendingGarbage: 8,
      totalAttackSent: 7
    }),
    2
  );
  assert.equal(
    openerCancellationMultiplier({
      piecesPlacedBeforeLock: 14,
      pendingGarbage: 8,
      totalAttackSent: 7
    }),
    1
  );
  assert.equal(
    openerCancellationMultiplier({
      piecesPlacedBeforeLock: 0,
      pendingGarbage: 7,
      totalAttackSent: 7
    }),
    1
  );
});

test("invalid counters and RNG samples are rejected", () => {
  assert.throws(
    () =>
      resolveVersusAttack({
        lines: 1,
        spin: "none",
        combo: -1
      }),
    RangeError
  );
  assert.throws(() => splitSurgeAttack(1.5), RangeError);
  assert.throws(() => roundVersusAttack(1.25, "rng"), RangeError);
  assert.throws(() => roundVersusAttack(1.25, "rng", 1), RangeError);
});

