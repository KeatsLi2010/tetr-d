import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PLAYER_CONFIG } from "../src/config/v3/index.ts";
import { MatchInputController } from "../src/input/MatchInputController.ts";
import { InputOutbox } from "../src/realtime/InputOutbox.ts";

test("prediction runs before transport and does not wait for ACK", () => {
  const order: string[] = [];
  const outbox = new InputOutbox({
    matchId: "match-local",
    inputEpoch: 0,
    send: (message) => order.push(`send:${message.sequence}`)
  });
  const controller = new MatchInputController({
    config: DEFAULT_PLAYER_CONFIG,
    outbox,
    matchStartedAtMs: 1_000,
    simulationHz: 240,
    predict: () => order.push("predict")
  });

  controller.keyDown({ code: "ArrowLeft", atMs: 1_001 });
  controller.keyDown({ code: "ArrowUp", atMs: 1_002 });

  assert.deepEqual(order, [
    "predict",
    "send:0",
    "predict",
    "send:1"
  ]);
  assert.equal(outbox.pending.length, 2);
});

test("blur sends an ordered clearHeld barrier", () => {
  const kinds: string[] = [];
  const controller = new MatchInputController({
    config: DEFAULT_PLAYER_CONFIG,
    outbox: new InputOutbox({
      matchId: "match-blur",
      inputEpoch: 0,
      send: (message) => kinds.push(message.actions[0]!.kind)
    }),
    matchStartedAtMs: 0,
    simulationHz: 240,
    predict: () => undefined
  });

  controller.blur(5);
  assert.deepEqual(kinds, ["clearHeld"]);
});
