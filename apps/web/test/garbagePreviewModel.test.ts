import assert from "node:assert/strict";
import test from "node:test";

import type { PendingGarbagePacket } from "@tetr-d/protocol";

import {
  buildGarbagePreviewModel,
  estimateServerFrame,
  garbageUrgency
} from "../src/game/duel/garbagePreviewModel.ts";

function packet(
  packetId: string,
  amount: number,
  appliesAtFrame: number
): PendingGarbagePacket {
  return {
    packetId,
    sourcePlayerId: "rival",
    amount,
    appliesAtFrame
  };
}

test("garbage preview stacks packets in FIFO order", () => {
  const model = buildGarbagePreviewModel([
    packet("first", 3, 180),
    packet("second", 4, 160)
  ], 100, 80);

  assert.deepEqual(
    model.segments.map((segment) => segment.packetId),
    ["first", "second"]
  );
  assert.deepEqual(
    model.segments.map((segment) => ({
      amount: segment.amount,
      bottomPercent: segment.bottomPercent,
      heightPercent: segment.heightPercent
    })),
    [
      { amount: 3, bottomPercent: 0, heightPercent: 15 },
      { amount: 4, bottomPercent: 15, heightPercent: 20 }
    ]
  );
});

test("garbage urgency transitions from green through yellow to red", () => {
  const green = garbageUrgency(180, 100, 80);
  const yellow = garbageUrgency(140, 100, 80);
  const red = garbageUrgency(100, 100, 80);

  assert.deepEqual(
    [green.hue, yellow.hue, red.hue],
    [120, 60, 0]
  );
  assert.deepEqual(
    [green.color, yellow.color, red.color],
    [
      "hsl(120.0 88% 56%)",
      "hsl(60.0 88% 56%)",
      "hsl(0.0 88% 56%)"
    ]
  );
  assert.deepEqual(
    [green.ready, yellow.ready, red.ready],
    [false, false, true]
  );
});

test("server-frame extrapolation freezes after 100ms", () => {
  const anchor = { serverFrame: 1_000, receivedAtMs: 100 };

  assert.equal(estimateServerFrame(anchor, 50, 240), 1_000);
  assert.equal(estimateServerFrame(anchor, 150, 240), 1_012);
  assert.equal(estimateServerFrame(anchor, 200, 240), 1_024);
  assert.equal(estimateServerFrame(anchor, 500, 240), 1_024);
});

test("25 ready rows expose 20 rows and report the hidden remainder", () => {
  const model = buildGarbagePreviewModel([
    packet("first", 10, 100),
    packet("second", 15, 100)
  ], 100, 80);

  assert.equal(model.totalAmount, 25);
  assert.equal(model.visibleAmount, 20);
  assert.equal(model.hiddenAmount, 5);
  assert.equal(model.readyAmount, 25);
  assert.deepEqual(
    model.segments.map((segment) => ({
      packetId: segment.packetId,
      amount: segment.amount,
      ready: segment.ready
    })),
    [
      { packetId: "first", amount: 10, ready: true },
      { packetId: "second", amount: 10, ready: true }
    ]
  );
});

test("empty garbage queue produces an empty preview", () => {
  assert.deepEqual(buildGarbagePreviewModel([], 100, 80), {
    totalAmount: 0,
    visibleAmount: 0,
    hiddenAmount: 0,
    nextRemainingFrames: null,
    readyAmount: 0,
    segments: []
  });
});
