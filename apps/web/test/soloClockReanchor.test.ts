import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PLAYER_CONFIG } from "../src/config/v3/index.ts";
import { GameHandlingController } from "../src/game/input/GameHandlingController.ts";
import { SoloGameSession } from "../src/game/solo/SoloGameSession.ts";

const SEED = [1, 2, 3, 4] as const;

test("dropping a long clock backlog also clears stale Handling repeats", () => {
  let now = 0;
  let maxActionsInTick = 0;
  const reanchors: number[] = [];
  const controller = new GameHandlingController(DEFAULT_PLAYER_CONFIG);
  const session = new SoloGameSession({
    seed: SEED,
    now: () => now,
    actionsForTick(tickTimeMs) {
      const actions = controller.actionsForTick(tickTimeMs);
      maxActionsInTick = Math.max(maxActionsInTick, actions.length);
      return actions;
    },
    onClockReanchored(atMs) {
      reanchors.push(atMs);
      controller.clear(atMs);
    }
  });

  session.start();
  controller.keyDown({ code: "ArrowLeft", atMs: 0 });
  now = 100_000;
  session.advanceTo();

  assert.equal(session.snapshot.frame, 240);
  assert.deepEqual(reanchors, [100_000]);
  assert.ok(maxActionsInTick <= 1);

  now += 1_000 / 240;
  assert.doesNotThrow(() => session.advanceTo());
  assert.equal(session.snapshot.frame, 241);
  assert.deepEqual(reanchors, [100_000]);
});
