import assert from "node:assert/strict";
import test from "node:test";

import {
  I_180_KICKS,
  I_90_KICKS,
  JLSTZ_180_KICKS,
  JLSTZ_90_KICKS,
  getKickTests,
  targetRotation
} from "../src/srsPlus.ts";

function mirrorX(
  kicks: readonly { readonly x: number; readonly y: number }[]
): readonly { readonly x: number; readonly y: number }[] {
  return kicks.map((kick) => ({
    x: kick.x === 0 ? 0 : -kick.x,
    y: kick.y
  }));
}

function invert(
  kicks: readonly { readonly x: number; readonly y: number }[]
): readonly { readonly x: number; readonly y: number }[] {
  return kicks.map((kick) => ({
    x: kick.x === 0 ? 0 : -kick.x,
    y: kick.y === 0 ? 0 : -kick.y
  }));
}

test("rotation state transitions are stable", () => {
  assert.equal(targetRotation(0, "cw"), 1);
  assert.equal(targetRotation(0, "ccw"), 3);
  assert.equal(targetRotation(3, "cw"), 0);
  assert.equal(targetRotation(1, "180"), 3);
});

test("JLSTZ keeps the Guideline 0→R kick order", () => {
  assert.deepEqual(JLSTZ_90_KICKS["0>1"], [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: -1, y: 1 },
    { x: 0, y: -2 },
    { x: -1, y: -2 }
  ]);
});

test("SRS+ I 0→R uses the symmetric reordered candidates", () => {
  assert.deepEqual(I_90_KICKS["0>1"], [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: -2, y: 0 },
    { x: -2, y: -1 },
    { x: 1, y: 2 }
  ]);
});

test("I 0→R and 0→L orders mirror each other", () => {
  assert.deepEqual(I_90_KICKS["0>3"], mirrorX(I_90_KICKS["0>1"] ?? []));
});

test("I R→0 and L→0 orders mirror each other", () => {
  assert.deepEqual(I_90_KICKS["3>0"], mirrorX(I_90_KICKS["1>0"] ?? []));
});

test("I R→2 and L→2 orders mirror each other", () => {
  assert.deepEqual(I_90_KICKS["3>2"], mirrorX(I_90_KICKS["1>2"] ?? []));
});

test("I 2→R and 2→L orders mirror each other", () => {
  assert.deepEqual(I_90_KICKS["2>3"], mirrorX(I_90_KICKS["2>1"] ?? []));
});

test("JLSTZ 0→2 has the restrained six-test 180° order", () => {
  assert.deepEqual(JLSTZ_180_KICKS["0>2"], [
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
    { x: 1, y: 0 },
    { x: -1, y: 0 }
  ]);
});

test("JLSTZ 0→2 and 2→0 are inverse ordered kicks", () => {
  const forward = JLSTZ_180_KICKS["0>2"] ?? [];
  const reverse = JLSTZ_180_KICKS["2>0"] ?? [];

  assert.deepEqual(reverse, invert(forward));
});

test("I 180° exposes only basic position and one restrained kick", () => {
  assert.deepEqual(I_180_KICKS["1>3"], [
    { x: 0, y: 0 },
    { x: 1, y: 0 }
  ]);
});

test("O never translates during rotation", () => {
  assert.deepEqual(getKickTests("O", 0, "cw"), [{ x: 0, y: 0 }]);
  assert.deepEqual(getKickTests("O", 0, "180"), [{ x: 0, y: 0 }]);
});

test("published kick tables are frozen at runtime", () => {
  const tests = I_90_KICKS["0>1"] ?? [];

  assert.equal(Object.isFrozen(I_90_KICKS), true);
  assert.equal(Object.isFrozen(tests), true);
  assert.equal(Object.isFrozen(tests[0]), true);
  assert.throws(() => {
    (tests as unknown as { x: number; y: number }[])[0] = { x: 99, y: 99 };
  }, TypeError);
});
