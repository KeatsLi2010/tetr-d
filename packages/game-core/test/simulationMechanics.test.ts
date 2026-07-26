import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelGarbageWithAttack,
  classifyAllMiniPlusSpin,
  createBoard,
  createPlayerSimulationRules,
  applyReadyGarbage
} from "../src/index.ts";

test("rule durations stay constant when simulation Hz changes", () => {
  const at60 = createPlayerSimulationRules(60);
  const at240 = createPlayerSimulationRules(240);
  assert.equal(at60.lockDelayFrames, 30);
  assert.equal(at240.lockDelayFrames, 120);
  assert.equal(at60.dasFrames, 6);
  assert.equal(at240.dasFrames, 24);
  assert.equal(at60.garbageTravelFrames, 20);
  assert.equal(at240.garbageTravelFrames, 80);
});

test("three-corner T detection distinguishes full and Mini fronts", () => {
  const full = createBoard([
    (1 << 3),
    0,
    (1 << 3) | (1 << 5)
  ]);
  const mini = createBoard([
    (1 << 3) | (1 << 5),
    0,
    (1 << 3)
  ]);
  const piece = { kind: "T" as const, rotation: 0 as const, x: 3, y: 0 };
  const rotation = { direction: "cw" as const, kickIndex: 0 };
  assert.equal(classifyAllMiniPlusSpin(full, piece, rotation), "full");
  assert.equal(classifyAllMiniPlusSpin(mini, piece, rotation), "mini");
  assert.equal(classifyAllMiniPlusSpin(full, piece, null), "none");
});

test("garbage cancellation is FIFO and opener defense spends half attack", () => {
  const packets = [
    { packetId: "a", sourcePlayerId: "p", amount: 3, appliesAtFrame: 2, hole: 1 },
    { packetId: "b", sourcePlayerId: "p", amount: 4, appliesAtFrame: 2, hole: 7 }
  ];
  const result = cancelGarbageWithAttack(packets, 2, 2);
  assert.equal(result.cancelled, 4);
  assert.equal(result.attackSpent, 2);
  assert.equal(result.outgoing, 0);
  assert.deepEqual(result.packets.map((packet) => [packet.packetId, packet.amount]), [
    ["b", 3]
  ]);
});

test("garbage waits for activation and a packet preserves one hole", () => {
  const packet = {
    packetId: "a",
    sourcePlayerId: "p",
    amount: 3,
    appliesAtFrame: 10,
    hole: 4
  };
  const waiting = applyReadyGarbage(createBoard(), [packet], 9, 8);
  assert.deepEqual(waiting.appliedHoles, []);
  const applied = applyReadyGarbage(waiting.board, waiting.packets, 10, 8);
  assert.deepEqual(applied.appliedHoles, [4, 4, 4]);
  assert.equal(applied.packets.length, 0);
});
