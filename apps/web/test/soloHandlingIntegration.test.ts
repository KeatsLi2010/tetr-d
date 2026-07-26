import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PLAYER_CONFIG } from "../src/config/v3/index.ts";
import { GameHandlingController } from "../src/game/input/GameHandlingController.ts";
import { SoloGameSession } from "../src/game/solo/SoloGameSession.ts";

const TICK_MS = 1_000 / 240;
const SEED = [1, 2, 3, 4] as const;

function controlledHarness(
  ruleOverrides: { readonly lockDelayMs?: number } = {}
) {
  const config = {
    ...DEFAULT_PLAYER_CONFIG,
    handling: {
      ...DEFAULT_PLAYER_CONFIG.handling,
      arrFrameTenths: 13,
      dasFrameTenths: 60,
      dcdFrameTenths: 105,
      sdf: "sonic" as const,
      dasCancellation: false,
      safeLock: true,
      preferSoftDrop: true
    }
  };
  const controller = new GameHandlingController(config);
  const spawns: string[] = [];
  const session = new SoloGameSession({
    seed: SEED,
    now: () => 0,
    ruleOverrides,
    actionsForTick: (atMs) => controller.actionsForTick(atMs),
    onPieceSpawned: (atMs, _frame, cause) => {
      spawns.push(cause);
      controller.notifyPieceSpawned(atMs, cause);
    }
  });
  session.start();
  controller.keyDown({ code: "ArrowLeft", atMs: 0 });
  session.advanceTo(150);
  return { controller, session, spawns };
}

test("held sonic soft drop is reapplied after every automatic lock", () => {
  const config = {
    ...DEFAULT_PLAYER_CONFIG,
    handling: {
      ...DEFAULT_PLAYER_CONFIG.handling,
      sdf: "sonic" as const,
      safeLock: true,
      preferSoftDrop: true
    }
  };
  const controller = new GameHandlingController(config);
  const session = new SoloGameSession({
    seed: SEED,
    now: () => 0,
    ruleOverrides: { lockDelayMs: 0 },
    actionsForTick: (tickTimeMs) =>
      controller.actionsForTick(tickTimeMs),
    onPieceSpawned: (atMs, _frame, cause) => {
      controller.notifyPieceSpawned(atMs, cause);
    }
  });

  session.start();
  controller.keyDown({ code: "ArrowDown", atMs: 0 });
  session.advanceTo(TICK_MS);
  assert.equal(session.snapshot.stats.pieces, 1);

  session.advanceTo(TICK_MS * 2);
  assert.equal(session.snapshot.stats.pieces, 2);
  assert.equal(session.snapshot.phase, "playing");
});

test("hard drop DCD keeps the next piece centered during its cut", () => {
  const { controller, session, spawns } = controlledHarness();
  controller.keyDown({ code: "Space", atMs: 150 });
  controller.keyUp({ code: "Space", atMs: 150 });
  session.advanceTo(150 + TICK_MS);

  const spawnX = session.snapshot.player.rules.spawnX;
  assert.deepEqual(spawns, ["hardDrop"]);
  assert.equal(session.snapshot.player.active?.x, spawnX);

  session.advanceTo(329);
  assert.equal(session.snapshot.player.active?.x, spawnX);
  session.advanceTo(345);
  assert.equal(session.snapshot.player.active?.x, spawnX - 1);
});

test("automatic lock applies the same confirmed-spawn DCD", () => {
  const { controller, session, spawns } = controlledHarness({
    lockDelayMs: 0
  });
  controller.keyDown({ code: "ArrowDown", atMs: 150 });
  controller.keyUp({ code: "ArrowDown", atMs: 150 });
  session.advanceTo(150 + TICK_MS);

  const spawnX = session.snapshot.player.rules.spawnX;
  assert.deepEqual(spawns, ["automatic"]);
  assert.equal(session.snapshot.player.active?.x, spawnX);
  session.advanceTo(329);
  assert.equal(session.snapshot.player.active?.x, spawnX);
  session.advanceTo(345);
  assert.equal(session.snapshot.player.active?.x, spawnX - 1);
});

test("successful Hold cuts DAS but a rejected Hold does not cut it twice", () => {
  const { controller, session, spawns } = controlledHarness();
  controller.keyDown({ code: "ShiftLeft", atMs: 150 });
  controller.keyUp({ code: "ShiftLeft", atMs: 150 });
  session.advanceTo(150 + TICK_MS);

  const spawnX = session.snapshot.player.rules.spawnX;
  const heldPiece = session.snapshot.player.active?.kind;
  assert.deepEqual(spawns, ["hold"]);
  assert.equal(session.snapshot.player.active?.x, spawnX);

  session.advanceTo(250);
  controller.keyDown({ code: "ShiftLeft", atMs: 250 });
  controller.keyUp({ code: "ShiftLeft", atMs: 250 });
  session.advanceTo(250 + TICK_MS);
  assert.deepEqual(spawns, ["hold"]);
  assert.equal(session.snapshot.player.active?.kind, heldPiece);

  session.advanceTo(345);
  assert.equal(session.snapshot.player.active?.x, spawnX - 1);
});
