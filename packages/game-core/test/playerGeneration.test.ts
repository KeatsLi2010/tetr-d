import assert from "node:assert/strict";
import test from "node:test";

import {
  PlayerSimulation,
  createBoard,
  createPlayerSimulationRules,
  type PieceKind,
  type SimulationPieceSource
} from "../src/index.ts";

class ArrayPieceSource implements SimulationPieceSource {
  #cursor = 0;
  readonly pieces: readonly PieceKind[];

  constructor(pieces: readonly PieceKind[]) {
    this.pieces = pieces;
  }

  draw(): PieceKind {
    const piece = this.pieces[this.#cursor];
    if (piece === undefined) throw new Error("piece source exhausted");
    this.#cursor += 1;
    return piece;
  }

  peek(count: number): readonly PieceKind[] {
    return this.pieces.slice(this.#cursor, this.#cursor + count);
  }

  getCursor(): number {
    return this.#cursor;
  }
}

function simulation(
  pieces: readonly PieceKind[],
  rows: readonly number[] = []
): PlayerSimulation {
  return new PlayerSimulation({
    playerId: "generation-test",
    rules: createPlayerSimulationRules(240),
    pieces: new ArrayPieceSource(pieces),
    nextAttackRoundingRoll: () => 0.5,
    initialBoard: createBoard(rows)
  });
}

test("generation buffers IHS before IRS and consumes both once", () => {
  const player = simulation(["T", "I", "O", "L", "J", "S", "Z"]);
  const buffered = player.advanceFrame(1, [
    { kind: "hardDrop" },
    { kind: "rotate", direction: "ccw" },
    { kind: "hold" }
  ]);
  assert.deepEqual(buffered.spawns, [{
    cause: "hardDrop",
    piece: "O",
    liftedRows: 0
  }]);
  assert.deepEqual({
    kind: player.view.active?.kind,
    rotation: player.view.active?.rotation,
    hold: player.view.hold,
    canHold: player.view.canHold,
    cursor: player.view.pieceCursor
  }, {
    kind: "O",
    rotation: 3,
    hold: "I",
    canHold: false,
    cursor: 3
  });

  player.advanceFrame(2, [{ kind: "hardDrop" }]);
  assert.deepEqual({
    kind: player.view.active?.kind,
    rotation: player.view.active?.rotation,
    hold: player.view.hold,
    canHold: player.view.canHold,
    cursor: player.view.pieceCursor
  }, {
    kind: "L",
    rotation: 0,
    hold: "I",
    canHold: true,
    cursor: 4
  });
});

test("successful IRS kick remains the last rotation for spin detection", () => {
  const player = simulation(
    ["I", "T", "O", "L", "J", "S", "Z"],
    [(1 << 3) | (1 << 5), 0, 1 << 3]
  );
  const frame = player.advanceFrame(1, [
    { kind: "moveToWall", direction: "right" },
    { kind: "hardDrop" },
    { kind: "rotate", direction: "cw" },
    { kind: "hardDrop" }
  ]);
  assert.equal(frame.locks.length, 2);
  assert.equal(frame.locks[1]?.piece, "T");
  assert.notEqual(frame.locks[1]?.spin, "none");
});
