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

function snapshot(next: readonly PieceKind[]): PlayerSnapshot {
  return {
    playerId: "self",
    boardRows: Array.from({ length: 40 }, () => 0),
    garbageRows: Array.from({ length: 40 }, () => false),
    active: { kind: "T", rotation: 0, x: 3, y: 17 },
    hold: null,
    next,
    combo: -1,
    backToBack: 0,
    piecesPlaced: 0,
    totalAttackSent: 0,
    pendingGarbage: [],
    toppedOut: false
  };
}

function privateState(): PrivateSimulationSnapshot {
  return {
    playerId: "self",
    pieceCursor: 1,
    pieceWindow: ["I", "O", "L", "S", "Z"],
    heldInputMask: 0,
    dasFrames: 0,
    arrFrames: 0,
    gravity256: 1,
    lockFrames: 0,
    lockResets: 0,
    canHold: true,
    pendingGarbage: []
  };
}

test("prediction performs buffered IHS before IRS after hard drop", () => {
  const initial = networkPlayerState(
    snapshot(["I", "O", "L", "S", "Z"]),
    privateState()
  );
  const predicted = applyPredictedActions(initial, [
    { kind: "hardDrop" },
    { kind: "rotate", direction: "ccw" },
    { kind: "hold" }
  ]);

  assert.deepEqual({
    active: predicted.active?.kind,
    rotation: predicted.active?.rotation,
    hold: predicted.hold,
    next: predicted.next,
    cursor: predicted.pieceCursor,
    canHold: predicted.canHold
  }, {
    active: "O",
    rotation: 3,
    hold: "I",
    next: ["L", "S", "Z"],
    cursor: 3,
    canHold: false
  });
});
