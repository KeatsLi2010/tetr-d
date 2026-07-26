import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MATCH_TICK_RATE_HZ,
  framesForMilliseconds,
  parseMatchTickRateHz,
  scale60HzFrames
} from "../src/matches/matchTiming.ts";

test("match tick rate defaults to 240 Hz and accepts bounded overrides", () => {
  assert.equal(parseMatchTickRateHz(undefined), DEFAULT_MATCH_TICK_RATE_HZ);
  assert.equal(parseMatchTickRateHz(""), 240);
  assert.equal(parseMatchTickRateHz("60"), 60);
  assert.equal(parseMatchTickRateHz("360"), 360);
  assert.equal(parseMatchTickRateHz("1000"), 1_000);
});

test("match tick rate rejects malformed and unsafe overrides", () => {
  for (const value of ["0", "59", "1001", "240.0", "+240", " 240", "abc"]) {
    assert.throws(() => parseMatchTickRateHz(value), /MATCH_TICK_RATE_HZ/);
  }
});

test("wall-clock rule durations scale without firing early", () => {
  assert.equal(framesForMilliseconds(500, 60), 30);
  assert.equal(framesForMilliseconds(500, 240), 120);
  assert.equal(framesForMilliseconds(333, 240), 80);
  assert.equal(framesForMilliseconds(4.2, 240), 2);
  assert.equal(scale60HzFrames(20, 240), 80);
  assert.equal(scale60HzFrames(30, 360), 180);
});
