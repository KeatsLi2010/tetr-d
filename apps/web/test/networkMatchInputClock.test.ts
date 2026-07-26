import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PLAYER_CONFIG } from "../src/config/v3/index.ts";
import { MatchInputController } from "../src/input/MatchInputController.ts";
import { InputOutbox } from "../src/realtime/InputOutbox.ts";

test("resumed matches anchor Handling locally while retaining server frames", () => {
  const sent: { readonly clientFrame: number }[] = [];
  const outbox = new InputOutbox({
    matchId: "long-running-match",
    inputEpoch: 4,
    send: (message) => sent.push(message)
  });
  const controller = new MatchInputController({
    config: DEFAULT_PLAYER_CONFIG,
    outbox,
    matchStartedAtMs: 50_000,
    clientFrameBase: 1_000_000,
    simulationHz: 240,
    predict: () => undefined
  });

  controller.keyDown({
    code: DEFAULT_PLAYER_CONFIG.bindings.moveLeft[0]!,
    atMs: 50_001
  });

  assert.equal(sent[0]?.clientFrame, 1_000_000);
});

test("authoritative snapshots cap client frame drift without delaying input", () => {
  const sent: { readonly clientFrame: number }[] = [];
  const controller = new MatchInputController({
    config: DEFAULT_PLAYER_CONFIG,
    outbox: new InputOutbox({
      matchId: "overloaded-server",
      inputEpoch: 0,
      send: (message) => sent.push(message)
    }),
    matchStartedAtMs: 1_000,
    clientFrameBase: 400,
    simulationHz: 240,
    predict: () => undefined
  });

  controller.synchronizeServerFrame(408, 1_040);
  controller.keyDown({
    code: DEFAULT_PLAYER_CONFIG.bindings.rotateCW[0]!,
    atMs: 6_040
  });
  assert.equal(sent[0]?.clientFrame, 432);

  controller.synchronizeServerFrame(416, 6_050);
  controller.keyDown({
    code: DEFAULT_PLAYER_CONFIG.bindings.rotate180[0]!,
    atMs: 6_051
  });
  assert.equal(sent[1]?.clientFrame, 416);

  controller.synchronizeServerFrame(415, 7_000);
  controller.keyDown({
    code: DEFAULT_PLAYER_CONFIG.bindings.rotateCCW[0]!,
    atMs: 7_001
  });
  assert.equal(sent[2]?.clientFrame, 440);
});
