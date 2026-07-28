import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PLAYER_CONFIG
} from "../src/config/v3/index.ts";
import {
  frameTenthsToMs,
  type PlayerConfig,
  type PlayerHandlingConfig,
  type PlayerKeyBindings
} from "../src/config/v3/index.ts";
import { HandlingEngine } from "../src/input/public.ts";
import {
  SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS
} from "../src/input/v3HandlingEngine.ts";

function configured(
  handling: Partial<PlayerHandlingConfig> = {},
  bindings: Partial<PlayerKeyBindings> = {}
): PlayerConfig {
  return {
    ...DEFAULT_PLAYER_CONFIG,
    handling: { ...DEFAULT_PLAYER_CONFIG.handling, ...handling },
    bindings: { ...DEFAULT_PLAYER_CONFIG.bindings, ...bindings }
  };
}

test("DAS emits first repeat immediately on charge, then follows ARR", () => {
  const engine = new HandlingEngine(configured({
    dasFrameTenths: 60,
    arrFrameTenths: 30
  }));
  assert.deepEqual(engine.keyDown({ code: "ArrowLeft", atMs: 0 }), [
    { kind: "shift", direction: "left", mode: "step" }
  ]);
  assert.deepEqual(engine.advance(99), []);
  assert.deepEqual(engine.advance(100), [
    { kind: "shift", direction: "left", mode: "step" }
  ]);
  assert.deepEqual(engine.advance(150), [
    { kind: "shift", direction: "left", mode: "step" }
  ]);
});

test("zero ARR becomes one explicit wall shift", () => {
  const engine = new HandlingEngine(configured({
    dasFrameTenths: 60,
    arrFrameTenths: 0
  }));
  engine.keyDown({ code: "ArrowRight", atMs: 0 });
  assert.deepEqual(engine.advance(100), [
    { kind: "shift", direction: "right", mode: "wall" }
  ]);
  assert.deepEqual(engine.advance(1_000), []);
});

test("DCD pauses charged DAS after rotation", () => {
  const dcd = frameTenthsToMs(20);
  const engine = new HandlingEngine(configured({
    dasFrameTenths: 60,
    arrFrameTenths: 0,
    dcdFrameTenths: 20
  }));
  engine.keyDown({ code: "ArrowLeft", atMs: 0 });
  engine.advance(100);
  assert.deepEqual(engine.keyDown({ code: "KeyX", atMs: 100 }), [
    { kind: "rotate", direction: "cw" }
  ]);
  assert.deepEqual(engine.advance(100 + dcd - 0.01), []);
  assert.deepEqual(engine.advance(100 + dcd), [
    { kind: "shift", direction: "left", mode: "wall" }
  ]);
});

test("DCD pauses charged DAS from the confirmed spawn time", () => {
  const engine = new HandlingEngine(configured({
    dasFrameTenths: 60,
    arrFrameTenths: 13,
    dcdFrameTenths: 105
  }));
  engine.keyDown({ code: "ArrowLeft", atMs: 0 });
  engine.advance(150);

  assert.deepEqual(
    engine.notifyPieceSpawned(150, "hardDrop"),
    []
  );
  assert.deepEqual(engine.advance(339.999), []);
  assert.deepEqual(engine.advance(340), [
    { kind: "shift", direction: "left", mode: "step" }
  ]);
});

test("last pressed direction wins and releasing it resumes the other", () => {
  const engine = new HandlingEngine(configured({
    dasFrameTenths: 60,
    arrFrameTenths: 30,
    dasCancellation: false
  }));
  engine.keyDown({ code: "ArrowLeft", atMs: 0 });
  assert.deepEqual(engine.keyDown({ code: "ArrowRight", atMs: 10 }), [
    { kind: "shift", direction: "right", mode: "step" }
  ]);
  assert.deepEqual(engine.keyUp({ code: "ArrowRight", atMs: 20 }), [
    { kind: "shift", direction: "left", mode: "step" }
  ]);
  assert.deepEqual(engine.advance(100), [
    { kind: "shift", direction: "left", mode: "step" }
  ]);
});

test("multiple keys for one action use reference counting", () => {
  const engine = new HandlingEngine(configured({}, {
    moveLeft: ["ArrowLeft", "KeyQ"]
  }));
  assert.equal(engine.keyDown({ code: "ArrowLeft", atMs: 0 }).length, 1);
  assert.deepEqual(engine.keyDown({ code: "KeyQ", atMs: 1 }), []);
  assert.deepEqual(engine.keyUp({ code: "ArrowLeft", atMs: 2 }), []);
  assert.equal(engine.activeDirection, "left");
  engine.keyUp({ code: "KeyQ", atMs: 3 });
  assert.equal(engine.activeDirection, null);
});

test("latest physical direction binding wins and releases back in order", () => {
  const engine = new HandlingEngine(configured({}, {
    moveLeft: ["ArrowLeft", "Numpad4"],
    moveRight: ["ArrowRight"]
  }));

  assert.deepEqual(engine.keyDown({ code: "ArrowLeft", atMs: 0 }), [
    { kind: "shift", direction: "left", mode: "step" }
  ]);
  assert.deepEqual(engine.keyDown({ code: "ArrowRight", atMs: 1 }), [
    { kind: "shift", direction: "right", mode: "step" }
  ]);
  assert.deepEqual(engine.keyDown({ code: "Numpad4", atMs: 2 }), [
    { kind: "shift", direction: "left", mode: "step" }
  ]);
  assert.deepEqual(engine.keyUp({ code: "Numpad4", atMs: 3 }), [
    { kind: "shift", direction: "right", mode: "step" }
  ]);
  assert.deepEqual(engine.keyUp({ code: "ArrowRight", atMs: 4 }), [
    { kind: "shift", direction: "left", mode: "step" }
  ]);
  assert.deepEqual(engine.keyUp({ code: "ArrowLeft", atMs: 5 }), []);
  assert.equal(engine.activeDirection, null);
});

test("OS repeat is ignored and blur clears every held action", () => {
  const engine = new HandlingEngine(configured());
  engine.keyDown({ code: "ArrowLeft", atMs: 0 });
  assert.deepEqual(
    engine.keyDown({ code: "ArrowLeft", atMs: 1, repeat: true }),
    []
  );
  engine.blur(2);
  assert.equal(engine.activeDirection, null);
  assert.deepEqual(engine.advance(2_000), []);
});

test("finite SDF emits cells while sonic SDF emits floor", () => {
  const finite = new HandlingEngine(
    configured({ sdf: 5 }),
    { softDropBaseCellsPerSecond: 2 }
  );
  assert.deepEqual(finite.keyDown({ code: "ArrowDown", atMs: 0 }), []);
  assert.deepEqual(finite.advance(250), [
    { kind: "softDrop", mode: "cells", cells: 2 }
  ]);

  const sonic = new HandlingEngine(configured({ sdf: "sonic" }));
  assert.deepEqual(sonic.keyDown({ code: "ArrowDown", atMs: 0 }), [
    { kind: "softDrop", mode: "floor" }
  ]);
  assert.deepEqual(sonic.notifyPieceSpawned(10), [
    { kind: "softDrop", mode: "floor" }
  ]);
});

test("conflicting bindings fire all actions in stable order", () => {
  const engine = new HandlingEngine(configured({}, {
    hardDrop: ["Space"],
    hold: ["Space"]
  }));
  assert.deepEqual(engine.keyDown({ code: "Space", atMs: 0 }), [
    { kind: "hardDrop" },
    { kind: "hold" }
  ]);
});

test("prefer soft drop controls simultaneous finite-drop and ARR order", () => {
  const preferred = new HandlingEngine(
    configured({
      dasFrameTenths: 60,
      arrFrameTenths: 30,
      sdf: 5,
      preferSoftDrop: true
    }),
    { softDropBaseCellsPerSecond: 2 }
  );
  preferred.keyDown({ code: "ArrowLeft", atMs: 0 });
  preferred.keyDown({ code: "ArrowDown", atMs: 0 });
  assert.deepEqual(preferred.advance(100), [
    { kind: "softDrop", mode: "cells", cells: 1 },
    { kind: "shift", direction: "left", mode: "step" }
  ]);

  const movementFirst = new HandlingEngine(
    configured({
      dasFrameTenths: 60,
      arrFrameTenths: 30,
      sdf: 5,
      preferSoftDrop: false
    }),
    { softDropBaseCellsPerSecond: 2 }
  );
  movementFirst.keyDown({ code: "ArrowLeft", atMs: 0 });
  movementFirst.keyDown({ code: "ArrowDown", atMs: 0 });
  assert.deepEqual(movementFirst.advance(100), [
    { kind: "shift", direction: "left", mode: "step" },
    { kind: "softDrop", mode: "cells", cells: 1 }
  ]);
});

test("safe lock blocks hard drop only inside an automatic-spawn window", () => {
  const engine = new HandlingEngine(configured({ safeLock: true }));
  engine.notifyPieceSpawned(0, "automatic");

  assert.deepEqual(engine.keyDown({
    code: "Space",
    atMs: SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS - 0.001
  }), []);
  assert.deepEqual(engine.keyDown({
    code: "Space",
    atMs: SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS
  }), []);
  engine.keyUp({
    code: "Space",
    atMs: SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS
  });
  assert.deepEqual(engine.keyDown({
    code: "Space",
    atMs: SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS
  }), [{ kind: "hardDrop" }]);
});

test("safe lock is disabled for input spawns and by its config switch", () => {
  const inputSpawn = new HandlingEngine(configured({ safeLock: true }));
  inputSpawn.notifyPieceSpawned(0);
  assert.deepEqual(inputSpawn.keyDown({ code: "Space", atMs: 0 }), [
    { kind: "hardDrop" }
  ]);

  const disabled = new HandlingEngine(configured({ safeLock: false }));
  disabled.notifyPieceSpawned(0, "automatic");
  assert.deepEqual(disabled.keyDown({ code: "Space", atMs: 0 }), [
    { kind: "hardDrop" }
  ]);
});

test("blocked safe-lock press has no DCD or held-soft-drop side effect", () => {
  const engine = new HandlingEngine(configured({
    dasFrameTenths: 60,
    dcdFrameTenths: 105,
    sdf: "sonic",
    safeLock: true
  }));
  engine.keyDown({ code: "ArrowLeft", atMs: 0 });
  engine.keyDown({ code: "ArrowDown", atMs: 0 });
  engine.notifyPieceSpawned(0, "automatic");

  assert.deepEqual(engine.keyDown({ code: "Space", atMs: 1 }), []);
  assert.deepEqual(engine.advance(274.999), []);
  assert.deepEqual(engine.advance(275), [
    { kind: "shift", direction: "left", mode: "step" }
  ]);
});
