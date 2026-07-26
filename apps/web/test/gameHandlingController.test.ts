import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PLAYER_CONFIG,
  type PlayerConfig
} from "../src/config/v3/index.ts";
import {
  GameHandlingController,
  type GameInputCommand
} from "../src/game/input/GameHandlingController.ts";
import {
  SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS
} from "../src/input/v3HandlingEngine.ts";

const CONTROLLED_CONFIG: PlayerConfig = {
  ...DEFAULT_PLAYER_CONFIG,
  handling: {
    ...DEFAULT_PLAYER_CONFIG.handling,
    arrFrameTenths: 13,
    dasFrameTenths: 60,
    dcdFrameTenths: 105,
    sdf: "sonic",
    dasCancellation: false,
    safeLock: true,
    preferSoftDrop: true
  }
};

test("controlled DAS and ARR actions stay on separate 240 Hz ticks", () => {
  const controller = new GameHandlingController(CONTROLLED_CONFIG);
  controller.keyDown({ code: "ArrowLeft", atMs: 0 });

  const actionFrames: number[] = [];
  for (let frame = 0; frame <= 35; frame += 1) {
    const actions = controller.actionsForTick(frame * (1_000 / 240));
    if (actions.length > 0) {
      assert.deepEqual(actions, [
        { kind: "moveStep", direction: "left" }
      ]);
      actionFrames.push(frame);
    }
  }

  assert.deepEqual(actionFrames, [0, 24, 30, 35]);
  assert.deepEqual(CONTROLLED_CONFIG.handling, {
    arrFrameTenths: 13,
    dasFrameTenths: 60,
    dcdFrameTenths: 105,
    sdf: "sonic",
    dasCancellation: false,
    safeLock: true,
    preferSoftDrop: true,
    irs: "hold",
    ihs: "hold"
  });
});

test("expanded actions map to concrete simulation actions", () => {
  const controller = new GameHandlingController(CONTROLLED_CONFIG);

  controller.keyDown({ code: "ArrowRight", atMs: 0 });
  controller.keyUp({ code: "ArrowRight", atMs: 0.1 });
  controller.keyDown({ code: "ArrowDown", atMs: 0.2 });
  controller.keyUp({ code: "ArrowDown", atMs: 0.3 });
  controller.keyDown({ code: "Space", atMs: 0.4 });
  controller.keyUp({ code: "Space", atMs: 0.5 });
  controller.keyDown({ code: "KeyX", atMs: 0.6 });
  controller.keyUp({ code: "KeyX", atMs: 0.7 });
  controller.keyDown({ code: "ShiftLeft", atMs: 0.8 });

  assert.deepEqual(controller.actionsForTick(1), [
    { kind: "moveStep", direction: "right" },
    { kind: "sonicDrop" },
    { kind: "hardDrop" },
    { kind: "rotate", direction: "cw" },
    { kind: "hold" }
  ]);
});

test("meta bindings return commands and never enter simulation actions", () => {
  const observed: GameInputCommand[] = [];
  const controller = new GameHandlingController(DEFAULT_PLAYER_CONFIG, {
    onCommand: (command) => observed.push(command)
  });

  assert.deepEqual(
    controller.keyDown({ code: "Escape", atMs: 1 }),
    ["forfeit"]
  );
  controller.keyUp({ code: "Escape", atMs: 1.1 });
  assert.deepEqual(
    controller.keyDown({ code: "KeyR", atMs: 2 }),
    ["retry"]
  );
  assert.deepEqual(
    controller.keyDown({ code: "KeyR", atMs: 2.1, repeat: true }),
    []
  );
  controller.keyUp({ code: "KeyR", atMs: 2.2 });
  assert.deepEqual(
    controller.keyDown({ code: "KeyT", atMs: 3 }),
    ["openChat"]
  );

  assert.deepEqual(observed, ["forfeit", "retry", "openChat"]);
  assert.deepEqual(controller.actionsForTick(4), []);
});

test("blur and clear discard pending actions and release held keys", () => {
  const controller = new GameHandlingController(CONTROLLED_CONFIG);
  controller.keyDown({ code: "ArrowLeft", atMs: 0 });
  controller.blur(1);
  assert.deepEqual(controller.actionsForTick(500), []);

  controller.keyDown({ code: "ArrowLeft", atMs: 501 });
  controller.clear(502);
  assert.deepEqual(controller.actionsForTick(1_000), []);

  controller.keyDown({ code: "ArrowLeft", atMs: 1_001 });
  assert.deepEqual(controller.actionsForTick(1_001), [
    { kind: "moveStep", direction: "left" }
  ]);
});

test("time may not move backwards and OS repeat adds no press", () => {
  const controller = new GameHandlingController(CONTROLLED_CONFIG);
  controller.keyDown({ code: "ArrowLeft", atMs: 10 });
  controller.keyDown({ code: "ArrowLeft", atMs: 11, repeat: true });
  assert.deepEqual(controller.actionsForTick(12), [
    { kind: "moveStep", direction: "left" }
  ]);
  assert.throws(
    () => controller.keyUp({ code: "ArrowLeft", atMs: 11.9 }),
    /never move backwards/
  );
});

test("controller forwards automatic-spawn safe lock without fake actions", () => {
  const controller = new GameHandlingController(CONTROLLED_CONFIG);
  controller.notifyPieceSpawned(0, "automatic");
  controller.keyDown({
    code: "Space",
    atMs: SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS - 0.001
  });
  assert.deepEqual(
    controller.actionsForTick(SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS),
    []
  );

  controller.keyUp({
    code: "Space",
    atMs: SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS
  });
  controller.keyDown({
    code: "Space",
    atMs: SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS
  });
  assert.deepEqual(
    controller.actionsForTick(SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS),
    [{ kind: "hardDrop" }]
  );
});
