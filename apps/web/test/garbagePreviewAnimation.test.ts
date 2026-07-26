import assert from "node:assert/strict";
import test from "node:test";

import type { PendingGarbagePacket } from "@tetr-d/protocol";

import {
  shouldAnimateGarbagePreview
} from "../src/game/render/garbagePreviewAnimation.ts";

function packet(
  amount: number,
  appliesAtFrame: number
): PendingGarbagePacket {
  return {
    packetId: `${amount}:${appliesAtFrame}`,
    sourcePlayerId: "rival",
    amount,
    appliesAtFrame
  };
}

test("empty and all-READY garbage do not start an animation loop", () => {
  assert.equal(shouldAnimateGarbagePreview([], 100), false);
  assert.equal(
    shouldAnimateGarbagePreview([
      packet(4, 80),
      packet(3, 100)
    ], 100),
    false
  );
});

test("one future packet keeps the preview clock active", () => {
  assert.equal(
    shouldAnimateGarbagePreview([
      packet(4, 100),
      packet(3, 101)
    ], 100),
    true
  );
});
