import assert from "node:assert/strict";
import test from "node:test";

import {
  FULL_ROW_MASK,
  createBoard
} from "../../../packages/game-core/src/index.ts";
import { RULESET_VERSION } from "../../../packages/protocol/src/versions.ts";
import { MatchCoordinator } from "../src/matches/matchCoordinator.ts";
import type {
  MatchCoordinatorOptions,
  MatchFinishedResult
} from "../src/matches/matchCoordinatorTypes.ts";
import { MatchPieceSequence, verifyMatchPieceSequenceReveal } from "../src/matchPieceSequence.ts";

// First bag starts T,I so PC tests can hold T and use the shared I.
const SEED = [123456789, 362436069, 521288629, 88675123] as const;

function coordinator(
  overrides: Partial<MatchCoordinatorOptions> = {}
): MatchCoordinator {
  const participants = ["alice", "bob"] as const;
  const sequence = new MatchPieceSequence({
    matchId: "match-1",
    rulesetVersion: RULESET_VERSION,
    playerIds: participants,
    seed: SEED
  });
  return new MatchCoordinator({
    matchId: "match-1",
    roomId: "room-1",
    participants,
    players: [
      { playerId: "alice", displayName: "Alice" },
      { playerId: "bob", displayName: "Bob" }
    ],
    sequence,
    tickRateHz: 240,
    randomSeeds: {
      firstAttack: 11,
      secondAttack: 22,
      garbageHole: 33
    },
    ...overrides
  });
}

test("both players receive one identical 7-Bag stream with independent cursors", () => {
  const match = coordinator();
  const aliceStart = match.startMessage("alice");
  const bobStart = match.startMessage("bob");
  const spectatorStart = match.startMessage("watcher");

  assert.deepEqual(aliceStart.selfPieceWindow, bobStart.selfPieceWindow);
  assert.equal(aliceStart.selfPieceWindow.length, 14);
  assert.equal(new Set(aliceStart.selfPieceWindow.slice(0, 7)).size, 7);
  assert.equal(new Set(aliceStart.selfPieceWindow.slice(7, 14)).size, 7);
  assert.equal(spectatorStart.selfPieceCursor, null);
  assert.deepEqual(spectatorStart.selfPieceWindow, []);
  assert.equal(aliceStart.simulationHz, 240);
  assert.equal(match.view.simulations[0].view.active?.kind,
    match.view.simulations[1].view.active?.kind);

  match.enqueueInput({
    playerId: "alice",
    inputEpoch: 0,
    sequence: 0,
    clientFrame: 0,
    actions: [{ kind: "hardDrop" }]
  });
  match.advanceOneFrame();
  assert.equal(match.sequence.getCursor("alice"), 2);
  assert.equal(match.sequence.getCursor("bob"), 1);
});

test("input is acknowledged then applied on the next authoritative frame", () => {
  const match = coordinator();
  const x = match.view.simulations[0].view.active!.x;
  const receipt = match.enqueueInput({
    playerId: "alice",
    inputEpoch: 0,
    sequence: 0,
    clientFrame: 0,
    actions: [{ kind: "move", direction: "left", pressed: true }]
  });
  assert.equal(receipt.acknowledgement.dispositions[0]?.status, "scheduled");
  assert.equal(match.view.simulations[0].view.active?.x, x);
  match.advanceOneFrame();
  assert.equal(match.view.simulations[0].view.active?.x, x - 1);
});

test("same-frame attacks cancel before either side receives garbage", () => {
  const missingColumn = FULL_ROW_MASK ^ (1 << 5);
  const pcBoard = createBoard([
    missingColumn,
    missingColumn,
    missingColumn,
    missingColumn
  ]);
  const match = coordinator({ initialBoards: [pcBoard, pcBoard] });
  for (const playerId of ["alice", "bob"] as const) {
    match.enqueueInput({
      playerId,
      inputEpoch: 0,
      sequence: 0,
      clientFrame: 0,
      actions: [
        { kind: "hold" },
        { kind: "rotate", direction: "cw" },
        { kind: "hardDrop" }
      ]
    });
  }
  match.advanceOneFrame();
  assert.equal(match.view.simulations[0].view.pendingGarbage.length, 0);
  assert.equal(match.view.simulations[1].view.pendingGarbage.length, 0);
  assert.equal(match.view.lastEventSequence, 0);
});

test("a one-sided attack creates one change-on-attack packet", () => {
  const missingColumn = FULL_ROW_MASK ^ (1 << 5);
  const match = coordinator({
    initialBoards: [createBoard([
      missingColumn,
      missingColumn,
      missingColumn,
      missingColumn
    ]), createBoard()]
  });
  match.enqueueInput({
    playerId: "alice",
    inputEpoch: 0,
    sequence: 0,
    clientFrame: 0,
    actions: [
      { kind: "hold" },
      { kind: "rotate", direction: "cw" },
      { kind: "hardDrop" }
    ]
  });
  match.advanceOneFrame();
  const packet = match.view.simulations[1].view.pendingGarbage[0];
  assert.equal(packet?.sourcePlayerId, "alice");
  assert.equal(packet?.amount, 9);
  assert.equal(packet?.appliesAtFrame, 81);
  assert.ok((packet?.hole ?? -1) >= 0 && (packet?.hole ?? 10) < 10);
  assert.equal(match.view.lastEventSequence, 1);
});

test("snapshots are throttled independently from the 240 Hz simulation", () => {
  const snapshots: number[] = [];
  const match = coordinator({
    snapshotRateHz: 30,
    onSnapshot: (view) => snapshots.push(view.serverFrame)
  });
  for (let frame = 0; frame < 24; frame += 1) match.advanceOneFrame();
  assert.deepEqual(snapshots, [8, 16, 24]);
  assert.equal(match.view.stateSequence, 3);
});

test("force finish is exactly once and reveals the committed 7-Bag", () => {
  const finishes: MatchFinishedResult[] = [];
  const match = coordinator({ onFinished: (result) => finishes.push(result) });
  const commitment = match.sequence.commitment;
  assert.equal(match.forceFinish("bob", "forfeit"), true);
  assert.equal(match.forceFinish("bob", "forfeit"), false);
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0]?.winnerPlayerId, "alice");
  assert.equal(
    verifyMatchPieceSequenceReveal(
      commitment,
      finishes[0]!.message.pieceSequenceReveal
    ),
    true
  );
});

test("spawn collision is adjudicated by the server on one logical frame", () => {
  const finishes: MatchFinishedResult[] = [];
  const blockedSpawn = createBoard([
    ...Array.from({ length: 18 }, () => 0),
    FULL_ROW_MASK,
    FULL_ROW_MASK
  ]);
  const match = coordinator({
    initialBoards: [blockedSpawn, createBoard()],
    onFinished: (result) => finishes.push(result)
  });
  match.advanceOneFrame();
  assert.equal(finishes[0]?.reason, "topout");
  assert.equal(finishes[0]?.winnerPlayerId, "bob");
  assert.equal(finishes[0]?.serverFrame, 1);
});
