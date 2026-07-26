import assert from "node:assert/strict";
import test from "node:test";

import type { PieceKind } from "@tetr-d/game-core";
import type {
  PlayerSnapshot,
  PrivateSimulationSnapshot
} from "@tetr-d/protocol";

import {
  applyPredictedActions,
  networkPlayerState
} from "../src/game/duel/networkPlayerState.ts";

function snapshot(
  active: PlayerSnapshot["active"],
  options: {
    readonly hold?: PieceKind | null;
    readonly next?: readonly PieceKind[];
  } = {}
): PlayerSnapshot {
  return {
    playerId: "self",
    boardRows: Array.from({ length: 40 }, () => 0),
    garbageRows: Array.from({ length: 40 }, () => false),
    active,
    hold: options.hold ?? null,
    next: options.next ?? ["I", "O", "S", "Z", "J"],
    combo: -1,
    backToBack: 0,
    piecesPlaced: 0,
    totalAttackSent: 0,
    pendingGarbage: [],
    toppedOut: false
  };
}

function privateState(
  pieceCursor = 1,
  canHold = true
): PrivateSimulationSnapshot {
  return {
    playerId: "self",
    pieceCursor,
    pieceWindow: ["I", "O", "S", "Z", "J"],
    heldInputMask: 0,
    dasFrames: 0,
    arrFrames: 0,
    gravity256: 1,
    lockFrames: 0,
    lockResets: 0,
    canHold,
    pendingGarbage: []
  };
}

test("network prediction moves the active piece immediately", () => {
  const initial = networkPlayerState(snapshot({
    kind: "T",
    rotation: 0,
    x: 3,
    y: 17
  }), privateState());

  const moved = applyPredictedActions(initial, [
    { kind: "moveStep", direction: "left" }
  ]);

  assert.equal(moved.active?.kind, "T");
  assert.equal(moved.active?.x, 2);
  assert.equal(moved.active?.y, 17);
  assert.equal(initial.active?.x, 3);
});

test("predicted hard drop locks and spawns the next piece", () => {
  const initial = networkPlayerState(snapshot({
    kind: "O",
    rotation: 0,
    x: 3,
    y: 17
  }, {
    next: ["I", "T", "S", "Z", "J"]
  }), privateState());

  const dropped = applyPredictedActions(initial, [{ kind: "hardDrop" }]);

  assert.equal(dropped.piecesPlaced, 1);
  assert.equal(dropped.board.rows.some((row) => row !== 0), true);
  assert.equal(dropped.active?.kind, "I");
  assert.equal(dropped.active?.y, 17);
  assert.deepEqual(dropped.next, ["T", "S", "Z", "J"]);
  assert.equal(dropped.pieceCursor, 2);
  assert.equal(dropped.canHold, true);
  assert.equal(dropped.toppedOut, false);
});

test("predicted empty hold consumes next and disables hold", () => {
  const initial = networkPlayerState(snapshot({
    kind: "T",
    rotation: 0,
    x: 3,
    y: 17
  }, {
    next: ["I", "O", "S", "Z", "J"]
  }), privateState());

  const held = applyPredictedActions(initial, [{ kind: "hold" }]);

  assert.equal(held.hold, "T");
  assert.equal(held.active?.kind, "I");
  assert.deepEqual(held.next, ["O", "S", "Z", "J"]);
  assert.equal(held.pieceCursor, 2);
  assert.equal(held.canHold, false);
});

test("predicted hold swap preserves the next queue and cursor", () => {
  const initial = networkPlayerState(snapshot({
    kind: "T",
    rotation: 0,
    x: 3,
    y: 17
  }, {
    hold: "L",
    next: ["I", "O", "S", "Z", "J"]
  }), privateState(4));

  const held = applyPredictedActions(initial, [{ kind: "hold" }]);

  assert.equal(held.hold, "T");
  assert.equal(held.active?.kind, "L");
  assert.deepEqual(held.next, initial.next);
  assert.equal(held.pieceCursor, 4);
  assert.equal(held.canHold, false);
});
