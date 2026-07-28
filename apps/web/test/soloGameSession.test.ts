import assert from "node:assert/strict";
import test from "node:test";

import {
  FULL_ROW_MASK,
  createBoard,
  type SevenBagSeed
} from "@tetr-d/game-core";

import { SoloGameSession } from "../src/game/solo/SoloGameSession.ts";
import { LocalSevenBagPieceSource } from "../src/game/solo/LocalSevenBagPieceSource.ts";

const SEED: SevenBagSeed = [1, 2, 3, 4];
const NEXT_SEED: SevenBagSeed = [5, 6, 7, 8];

test("dispatch queues input without advancing physical time, then restart resets", () => {
  let now = 0;
  const session = new SoloGameSession({ seed: SEED, now: () => now });
  const firstPiece = session.snapshot.player.active?.kind;
  session.start();

  session.dispatch({ kind: "moveStep", direction: "right" });
  session.dispatch({ kind: "hardDrop" });
  assert.equal(session.snapshot.frame, 0);
  assert.equal(session.snapshot.stats.pieces, 0);

  now = 5;
  session.advanceTo();
  assert.equal(session.snapshot.frame, 1);
  assert.equal(session.snapshot.stats.pieces, 1);

  session.restart();
  assert.equal(session.snapshot.phase, "playing");
  assert.equal(session.snapshot.frame, 0);
  assert.equal(session.snapshot.stats.pieces, 0);
  assert.equal(session.snapshot.player.active?.kind, firstPiece);
  assert.equal(session.snapshot.player.pieceCursor, 1);
});

test("restart can replace the seed through its fresh-seed factory", () => {
  let calls = 0;
  const session = new SoloGameSession({
    seed: SEED,
    nextSeed: () => {
      calls += 1;
      return NEXT_SEED;
    },
    now: () => 0
  });
  const expected = new LocalSevenBagPieceSource(NEXT_SEED);

  session.start();
  session.restart();

  assert.equal(calls, 1);
  assert.equal(session.snapshot.player.active?.kind, expected.draw());
  assert.deepEqual(
    session.snapshot.player.next,
    expected.peek(session.snapshot.player.next.length)
  );
});

test("paused time does not advance simulation or elapsed statistics", () => {
  let now = 0;
  const session = new SoloGameSession({ seed: SEED, now: () => now });
  session.start();
  now = 100;
  session.advanceTo();
  const pausedAt = session.pause();
  assert.equal(pausedAt.frame, 24);

  now = 1_000;
  session.advanceTo();
  assert.equal(session.snapshot.frame, 24);
  assert.equal(session.snapshot.stats.elapsedMs, 100);

  session.resume();
  now = 1_100;
  session.advanceTo();
  assert.equal(session.snapshot.frame, 48);
  assert.equal(session.snapshot.stats.elapsedMs, 200);
});

function runAtCadence(cadenceHz: number) {
  const tickTimes: number[] = [];
  const session = new SoloGameSession({
    seed: SEED,
    now: () => 0,
    actionsForTick(tickTimeMs, frame) {
      tickTimes.push(tickTimeMs);
      return (frame - 1) % 60 === 0 ? [{ kind: "hardDrop" }] : [];
    }
  });
  session.start();
  for (let sample = 1; sample <= cadenceHz; sample += 1) {
    session.advanceTo(Math.min(1_000, sample * 1_000 / cadenceHz));
  }
  session.advanceTo(1_000);
  return { snapshot: session.snapshot, tickTimes };
}

test("60/120/144 Hz callers produce the same 240 Hz result", () => {
  const at60 = runAtCadence(60);
  const at120 = runAtCadence(120);
  const at144 = runAtCadence(144);

  for (const result of [at60, at120, at144]) {
    assert.equal(result.snapshot.frame, 240);
    assert.equal(result.tickTimes.length, 240);
    assert.equal(result.snapshot.stats.pieces, 4);
  }
  assert.deepEqual(at60.snapshot.player.board, at120.snapshot.player.board);
  assert.deepEqual(at60.snapshot.player.board, at144.snapshot.player.board);
  assert.deepEqual(at60.snapshot.player.active, at144.snapshot.player.active);
  assert.deepEqual(at60.snapshot.stats, at144.snapshot.stats);
  assert.ok(
    at144.tickTimes.every(
      (time, index) => Math.abs(time - (index + 1) * 1_000 / 240) < 1e-6
    )
  );
});

test("a stalled page advances at most one second before re-anchoring", () => {
  const tickTimes: number[] = [];
  const reanchors: number[] = [];
  const session = new SoloGameSession({
    seed: SEED,
    now: () => 0,
    onClockReanchored(nowMs) {
      reanchors.push(nowMs);
    },
    actionsForTick(tickTimeMs) {
      tickTimes.push(tickTimeMs);
      return [];
    }
  });
  session.start();
  session.advanceTo(100_000);
  assert.equal(session.snapshot.frame, 240);
  assert.equal(tickTimes.length, 240);
  assert.deepEqual(reanchors, [100_000]);

  session.advanceTo(100_000 + 1_000 / 240);
  assert.equal(session.snapshot.frame, 241);
  assert.deepEqual(reanchors, [100_000]);
});

test("lock results feed line, piece, attack, PPS and APM statistics", () => {
  const iFirstSeed: SevenBagSeed = [
    6, 3_041_712_678, 596_033_226, 2_419_070_318
  ];
  const missingColumn = FULL_ROW_MASK ^ (1 << 5);
  const session = new SoloGameSession({
    seed: iFirstSeed,
    now: () => 0,
    initialBoard: createBoard(Array.from({ length: 4 }, () => missingColumn))
  });
  session.start();
  session.dispatch({ kind: "rotate", direction: "cw" });
  session.dispatch({ kind: "hardDrop" });
  session.advanceTo(1_000 / 240);

  const { stats, player } = session.snapshot;
  assert.equal(stats.lines, 4);
  assert.equal(stats.pieces, 1);
  assert.equal(stats.attack, 9);
  assert.equal(stats.attack, player.totalAttackSent);
  assert.ok(Math.abs(stats.pps - 240) < 1e-9);
  assert.ok(Math.abs(stats.apm - stats.attack * 14_400) < 1e-9);
});

test("a blocked initial spawn ends immediately", () => {
  const rows = Array.from({ length: 21 }, (_, index) =>
    index === 19 || index === 20 ? FULL_ROW_MASK : 0
  );
  const session = new SoloGameSession({
    seed: SEED,
    now: () => 0,
    initialBoard: createBoard(rows)
  });

  assert.equal(session.snapshot.phase, "idle");
  assert.equal(session.snapshot.player.toppedOut, true);
  assert.equal(session.start().phase, "ended");
  assert.equal(session.snapshot.stats.elapsedMs, 0);
});

test("natural lock reports one automatic piece spawn", () => {
  const spawns: Array<readonly [number, number, string]> = [];
  const session = new SoloGameSession({
    seed: SEED,
    now: () => 0,
    ruleOverrides: { lockDelayMs: 0 },
    onPieceSpawned(atMs, frame, cause) {
      spawns.push([atMs, frame, cause]);
    }
  });
  session.start();
  session.dispatch({ kind: "sonicDrop" });
  session.advanceTo(1_000 / 240);
  assert.equal(session.snapshot.stats.pieces, 1);
  assert.deepEqual(spawns, [[1_000 / 240, 1, "automatic"]]);
});

test("hard drop reports its confirmed input spawn", () => {
  const causes: string[] = [];
  const session = new SoloGameSession({
    seed: SEED,
    now: () => 0,
    onPieceSpawned(_atMs, _frame, cause) {
      causes.push(cause);
    }
  });
  session.start();
  session.dispatch({ kind: "hardDrop" });
  session.advanceTo(1_000 / 240);
  assert.equal(session.snapshot.stats.pieces, 1);
  assert.deepEqual(causes, ["hardDrop"]);
});

test("natural lock that tops out does not report a spawned piece", () => {
  const iFirstSeed: SevenBagSeed = [
    6, 3_041_712_678, 596_033_226, 2_419_070_318
  ];
  const centerFour = (
    (1 << 3) |
    (1 << 4) |
    (1 << 5) |
    (1 << 6)
  );
  const rows = Array.from(
    { length: 19 },
    (_, index) => index === 18 ? centerFour : 0
  );
  let spawns = 0;
  const session = new SoloGameSession({
    seed: iFirstSeed,
    now: () => 0,
    initialBoard: createBoard(rows),
    ruleOverrides: { lockDelayMs: 0 },
    onPieceSpawned() {
      spawns += 1;
    }
  });
  session.start();
  assert.equal(session.snapshot.phase, "playing");
  session.advanceTo(1_000 / 240);
  assert.equal(session.snapshot.phase, "ended");
  assert.equal(session.snapshot.stats.pieces, 1);
  assert.equal(spawns, 0);
});
