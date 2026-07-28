import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PLAYER_CONFIG } from "../src/config/v3/index.ts";
import { GenerationInputBuffer } from "../src/input/generationInputBuffer.ts";
import { HandlingEngine } from "../src/input/public.ts";

function configured(irs: "off" | "hold" | "tap", ihs = irs) {
  return {
    ...DEFAULT_PLAYER_CONFIG,
    handling: { ...DEFAULT_PLAYER_CONFIG.handling, irs, ihs }
  };
}

test("automatic generation consumes IHS before the last-held IRS", () => {
  const buffer = new GenerationInputBuffer(configured("hold"));
  buffer.keyDown("ShiftLeft");
  buffer.keyDown("ControlLeft");

  assert.deepEqual(buffer.spawned("automatic"), [
    { kind: "hold" },
    { kind: "rotate", direction: "ccw" }
  ]);
});

test("tap buffering is one-shot even while the physical key stays down", () => {
  const buffer = new GenerationInputBuffer(configured("tap", "off"));
  buffer.keyDown("KeyA");
  assert.deepEqual(buffer.spawned("automatic"), [
    { kind: "rotate", direction: "180" }
  ]);
  assert.deepEqual(buffer.spawned("automatic"), []);
});

test("hold buffering repeats across generations and stops on release", () => {
  const buffer = new GenerationInputBuffer(configured("hold", "off"));
  buffer.keyDown("KeyX");
  assert.deepEqual(buffer.spawned("automatic"), [
    { kind: "rotate", direction: "cw" }
  ]);
  assert.deepEqual(buffer.spawned("automatic"), [
    { kind: "rotate", direction: "cw" }
  ]);
  buffer.keyUp("KeyX");
  assert.deepEqual(buffer.spawned("automatic"), []);
});

test("held IRS follows the newest physical rotation binding", () => {
  const buffer = new GenerationInputBuffer(configured("hold", "off"));
  buffer.keyDown("KeyX");
  buffer.keyDown("ControlLeft");
  buffer.keyDown("Numpad1");

  assert.deepEqual(buffer.spawned("automatic"), [
    { kind: "rotate", direction: "cw" }
  ]);
  buffer.keyUp("Numpad1");
  assert.deepEqual(buffer.spawned("automatic"), [
    { kind: "rotate", direction: "ccw" }
  ]);
});

test("prepared hard-drop buffering is emitted and confirmed only once", () => {
  const engine = new HandlingEngine(configured("hold", "off"));
  assert.deepEqual(engine.keyDown({ code: "KeyX", atMs: 0 }), [
    { kind: "rotate", direction: "cw" }
  ]);
  assert.deepEqual(engine.keyDown({ code: "Space", atMs: 1 }), [
    { kind: "hardDrop" },
    { kind: "rotate", direction: "cw" }
  ]);
  assert.deepEqual(engine.notifyPieceSpawned(1, "hardDrop"), []);

  engine.keyUp({ code: "Space", atMs: 2 });
  assert.deepEqual(engine.keyDown({ code: "Space", atMs: 3 }), [
    { kind: "hardDrop" },
    { kind: "rotate", direction: "cw" }
  ]);
});

test("held IHS and IRS are appended to hard drop in priority order", () => {
  const engine = new HandlingEngine(configured("hold"));
  assert.deepEqual(engine.keyDown({ code: "ShiftLeft", atMs: 0 }), [
    { kind: "hold" }
  ]);
  assert.deepEqual(engine.notifyPieceSpawned(0, "hold"), []);
  engine.keyDown({ code: "KeyX", atMs: 1 });

  assert.deepEqual(engine.keyDown({ code: "Space", atMs: 2 }), [
    { kind: "hardDrop" },
    { kind: "hold" },
    { kind: "rotate", direction: "cw" }
  ]);
});
