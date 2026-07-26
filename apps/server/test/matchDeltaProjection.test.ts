import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPlayerPatches,
  createPlayerPatches,
  type MatchEvent
} from "../../../packages/protocol/src/messages.ts";
import { RULESET_VERSION } from "../../../packages/protocol/src/versions.ts";
import { MatchPieceSequence } from "../src/matchPieceSequence.ts";
import { MatchCoordinator } from "../src/matches/matchCoordinator.ts";
import type { MatchCoordinatorView } from "../src/matches/matchCoordinatorTypes.ts";
import { projectMatchUpdate } from "../src/matches/matchDeltaProjection.ts";
import { MatchDeliveryBaselines } from "../src/matches/matchDeliveryBaselines.ts";

const PLAYERS = [
  { playerId: "alice", displayName: "Alice" },
  { playerId: "bob", displayName: "Bob" }
] as const;

function coordinator(): MatchCoordinator {
  return new MatchCoordinator({
    matchId: "delta-match",
    roomId: "delta-room",
    participants: ["alice", "bob"],
    players: PLAYERS,
    sequence: new MatchPieceSequence({
      matchId: "delta-match",
      rulesetVersion: RULESET_VERSION,
      playerIds: ["alice", "bob"],
      seed: [1, 2, 3, 4]
    }),
    tickRateHz: 240,
    snapshotRateHz: 30,
    randomSeeds: {
      firstAttack: 11,
      secondAttack: 22,
      garbageHole: 33
    }
  });
}

function advanceSnapshot(
  match: MatchCoordinator,
  sequence: number
): void {
  match.enqueueInput({
    playerId: "alice",
    inputEpoch: 0,
    sequence,
    clientFrame: match.view.serverFrame,
    actions: [{
      kind: "moveStep",
      direction: sequence % 2 === 0 ? "left" : "right"
    }]
  });
  for (let frame = 0; frame < 8; frame += 1) {
    match.advanceOneFrame();
  }
}

test("first delivery is full, then active-only deltas reuse board arrays", (t) => {
  const match = coordinator();
  const first = projectMatchUpdate(match.view, "alice", null);
  assert.equal(first.message.type, "match.snapshot");
  if (first.message.type !== "match.snapshot") {
    throw new Error("Expected initial full snapshot.");
  }
  advanceSnapshot(match, 0);
  const second = projectMatchUpdate(
    match.view,
    "alice",
    first.nextBaseline
  );
  assert.equal(second.message.type, "match.delta");
  if (second.message.type !== "match.delta") {
    throw new Error("Expected active-only delta.");
  }
  assert.equal(
    second.message.patches.some((patch) => patch.changedRows !== undefined),
    false
  );
  const applied = applyPlayerPatches(
    first.nextBaseline.players,
    second.message.patches
  );
  assert.equal(
    applied[0]?.boardRows,
    first.nextBaseline.players[0]?.boardRows
  );
  assert.equal(
    applied[0]?.garbageRows,
    first.nextBaseline.players[0]?.garbageRows
  );
  assert.deepEqual(applied, second.nextBaseline.players);
  assert.ok(second.sentBytes < second.fullBytes * 0.6);

  let baseline = second.nextBaseline;
  let fullBytes = first.fullBytes + second.fullBytes;
  let sentBytes = first.sentBytes + second.sentBytes;
  for (let index = 1; index < 30; index += 1) {
    advanceSnapshot(match, index);
    const update = projectMatchUpdate(match.view, "alice", baseline);
    baseline = update.nextBaseline;
    fullBytes += update.fullBytes;
    sentBytes += update.sentBytes;
  }
  const ratio = sentBytes / fullBytes;
  t.diagnostic(
    `240Hz simulation / 30Hz transport: ${sentBytes}/${fullBytes} bytes (${(ratio * 100).toFixed(1)}%)`
  );
  assert.ok(ratio < 0.55);
});

test("changed board rows include both bits and garbage provenance", () => {
  const match = coordinator();
  const before = projectMatchUpdate(
    match.view,
    "alice",
    null
  ).nextBaseline.players;
  const first = before[0]!;
  const boardRows = [...first.boardRows];
  const garbageRows = [...first.garbageRows];
  boardRows[0] = 0b11_1111_1110;
  garbageRows[0] = true;
  const after = [
    {
      ...first,
      boardRows: Object.freeze(boardRows),
      garbageRows: Object.freeze(garbageRows)
    },
    before[1]!
  ];
  const patches = createPlayerPatches(before, after);
  assert.notEqual(patches, null);
  assert.deepEqual(patches?.[0]?.changedRows, [{
    y: 0,
    bits: 0b11_1111_1110,
    garbage: true
  }]);
  assert.deepEqual(applyPlayerPatches(before, patches!), after);
});

test("oversized event delta automatically falls back to a full snapshot", () => {
  const match = coordinator();
  const baseline = projectMatchUpdate(
    match.view,
    "alice",
    null
  ).nextBaseline;
  const events: MatchEvent[] = Array.from({ length: 120 }, (_, index) => ({
    eventSequence: index + 1,
    kind: "garbage.queued",
    packet: {
      packetId: `packet-${index}-${"x".repeat(40)}`,
      sourcePlayerId: "bob",
      amount: 1,
      appliesAtFrame: 100 + index
    },
    targetPlayerId: "alice",
    holeSeed: index % 10
  }));
  const current: MatchCoordinatorView = Object.freeze({
    ...match.view,
    stateSequence: match.view.stateSequence + 1,
    serverFrame: match.view.serverFrame + 1,
    lastEventSequence: events.length,
    events: Object.freeze(events)
  });
  const update = projectMatchUpdate(current, "alice", baseline);
  assert.equal(update.message.type, "match.snapshot");
  assert.equal(update.sentBytes, update.fullBytes);
});

test("rejected delivery and connection generation changes force full", () => {
  const match = coordinator();
  const delivery = new MatchDeliveryBaselines();
  const rejected = projectMatchUpdate(match.view, "alice", null);
  assert.equal(rejected.message.type, "match.snapshot");

  advanceSnapshot(match, 0);
  const afterReject = projectMatchUpdate(
    match.view,
    "alice",
    delivery.get("delta-match", "alice", 0)
  );
  assert.equal(afterReject.message.type, "match.snapshot");
  delivery.accept(
    "delta-match",
    "alice",
    0,
    afterReject.nextBaseline
  );

  advanceSnapshot(match, 1);
  const accepted = projectMatchUpdate(
    match.view,
    "alice",
    delivery.get("delta-match", "alice", 0)
  );
  assert.equal(accepted.message.type, "match.delta");
  delivery.accept(
    "delta-match",
    "alice",
    0,
    accepted.nextBaseline
  );

  const newGeneration = projectMatchUpdate(
    match.view,
    "alice",
    delivery.get("delta-match", "alice", 1)
  );
  assert.equal(newGeneration.message.type, "match.snapshot");
  delivery.reject("delta-match", "alice");
  assert.equal(delivery.get("delta-match", "alice", 1), null);
});
