import assert from "node:assert/strict";
import test from "node:test";

import {
  FULL_ROW_MASK,
  PlayerSimulation,
  createBoard,
  createPlayerSimulationRules,
  findPieceSpawnPlacement,
  type PieceKind,
  type SimulationPieceSource,
  worldCellsFor
} from "../src/index.ts";

class ArrayPieceSource implements SimulationPieceSource {
  readonly #pieces: readonly PieceKind[];
  #cursor = 0;

  constructor(pieces: readonly PieceKind[]) {
    this.#pieces = pieces;
  }

  draw(): PieceKind {
    const piece = this.#pieces[this.#cursor];
    if (piece === undefined) throw new Error("test piece source exhausted");
    this.#cursor += 1;
    return piece;
  }

  peek(count: number): readonly PieceKind[] {
    return this.#pieces.slice(this.#cursor, this.#cursor + count);
  }

  getCursor(): number { return this.#cursor; }
}

function simulation(
  pieces: readonly PieceKind[],
  initialBoard = createBoard(),
  tickRateHz = 240,
  nextAttackRoundingRoll: () => number = () => 0.5
): PlayerSimulation {
  return new PlayerSimulation({
    playerId: "alice",
    rules: createPlayerSimulationRules(tickRateHz),
    pieces: new ArrayPieceSource(pieces),
    nextAttackRoundingRoll,
    initialBoard
  });
}

test("hold consumes only an empty hold and resets after lock", () => {
  const player = simulation(["T", "I", "O", "L", "J", "S", "Z"]);
  assert.equal(player.view.active?.kind, "T");
  assert.equal(player.view.pieceCursor, 1);

  const firstHold = player.advanceFrame(1, [{ kind: "hold" }]);
  assert.deepEqual(firstHold.spawns, [{
    cause: "hold",
    piece: "I",
    liftedRows: 0
  }]);
  assert.equal(player.view.active?.kind, "I");
  assert.equal(player.view.hold, "T");
  assert.equal(player.view.pieceCursor, 2);
  assert.equal(player.view.canHold, false);

  const rejectedHold = player.advanceFrame(2, [{ kind: "hold" }]);
  assert.deepEqual(rejectedHold.spawns, []);
  assert.equal(player.view.active?.kind, "I");
  assert.equal(player.view.pieceCursor, 2);

  const hardDrop = player.advanceFrame(3, [{ kind: "hardDrop" }]);
  assert.deepEqual(hardDrop.spawns, [{
    cause: "hardDrop",
    piece: "O",
    liftedRows: 0
  }]);
  assert.equal(player.view.active?.kind, "O");
  assert.equal(player.view.canHold, true);
  const swapHold = player.advanceFrame(4, [{ kind: "hold" }]);
  assert.deepEqual(swapHold.spawns, [{
    cause: "hold",
    piece: "T",
    liftedRows: 0
  }]);
  assert.equal(player.view.active?.kind, "T");
  assert.equal(player.view.hold, "O");
  assert.equal(player.view.pieceCursor, 3);
});

test("normal spawn is fully visible and ignores a tower outside its footprint", () => {
  const rows = Array.from(
    { length: 31 },
    (_, y) => y >= 19 ? 1 : 0
  );
  const player = simulation(
    ["T", "I", "O", "L", "J", "S", "Z"],
    createBoard(rows)
  );
  const active = player.view.active;

  assert.equal(player.view.toppedOut, false);
  assert.equal(active?.y, 17);
  assert.equal(
    active === null
      ? false
      : worldCellsFor(
          active.kind,
          active.rotation,
          active.x,
          active.y
        ).every(({ y }) => y <= 19),
    true
  );
});

test("spawn lift is opt-in and chooses the lowest legal row", () => {
  const rows = Array.from({ length: 19 }, () => 0);
  rows[18] = 1 << 4;
  const board = createBoard(rows);
  const options = {
    board,
    kind: "T" as const,
    spawnX: 3,
    spawnY: 17
  };

  assert.equal(findPieceSpawnPlacement({
    ...options,
    allowClutchLift: false
  }), null);
  assert.deepEqual(findPieceSpawnPlacement({
    ...options,
    allowClutchLift: true
  }), {
    piece: { kind: "T", rotation: 0, x: 3, y: 18 },
    liftedRows: 1
  });
});

test("ordinary Hold and a non-clear never receive Clutch lift", () => {
  const rows = Array.from({ length: 20 }, () => 0);
  rows[19] = 1 << 6;
  const board = createBoard(rows);
  const holdPlayer = simulation(
    ["T", "I", "O", "L", "J", "S", "Z"],
    board
  );
  const hold = holdPlayer.advanceFrame(1, [{ kind: "hold" }]);
  assert.equal(hold.toppedOut, true);
  assert.deepEqual(hold.spawns, []);
  assert.equal(holdPlayer.view.active, null);

  const missPlayer = simulation(
    ["T", "I", "O", "L", "J", "S", "Z"],
    board
  );
  const miss = missPlayer.advanceFrame(1, [{ kind: "hardDrop" }]);
  assert.equal(miss.locks[0]?.lines, 0);
  assert.equal(miss.toppedOut, true);
  assert.deepEqual(miss.spawns, []);
  assert.equal(missPlayer.view.pieceCursor, 2);
});

test("a line clear grants the next piece and its Hold replacement Clutch lift", () => {
  const centerFour = (
    (1 << 3) |
    (1 << 4) |
    (1 << 5) |
    (1 << 6)
  );
  const rows = Array.from({ length: 21 }, () => 0);
  rows[18] = centerFour;
  rows[19] = FULL_ROW_MASK ^ centerFour;
  rows[20] = 1 << 4;
  const player = simulation(
    ["I", "O", "T", "L", "J", "S", "Z"],
    createBoard(rows)
  );

  const clear = player.advanceFrame(1, [{ kind: "hardDrop" }]);
  assert.equal(clear.locks[0]?.lines, 1);
  assert.deepEqual(clear.spawns, [{
    cause: "hardDrop",
    piece: "O",
    liftedRows: 2
  }]);
  assert.equal(player.view.active?.y, 19);
  assert.equal(player.view.toppedOut, false);
  assert.equal(player.view.pieceCursor, 2);

  const hold = player.advanceFrame(2, [{ kind: "hold" }]);
  assert.deepEqual(hold.spawns, [{
    cause: "hold",
    piece: "T",
    liftedRows: 2
  }]);
  assert.equal(player.view.active?.y, 19);
  assert.equal(player.view.pieceCursor, 3);
});

test("240 Hz gravity preserves the configured wall-clock rate", () => {
  const player = simulation(["T", "I", "O", "L", "J", "S"]);
  for (let frame = 1; frame < 200; frame += 1) player.advanceFrame(frame);
  assert.equal(player.view.active?.y, 17);
  player.advanceFrame(200);
  assert.equal(player.view.active?.y, 16);
});

test("hard drop, SRS+ rotation and a four-line all clear send nine", () => {
  const missingColumn = FULL_ROW_MASK ^ (1 << 5);
  const board = createBoard([
    missingColumn,
    missingColumn,
    missingColumn,
    missingColumn
  ]);
  const player = simulation(["I", "O", "T", "L", "J", "S", "Z"], board);
  const frame = player.advanceFrame(1, [
    { kind: "rotate", direction: "cw" },
    { kind: "hardDrop" }
  ]);

  assert.equal(frame.locks.length, 1);
  assert.equal(frame.locks[0]?.lines, 4);
  assert.equal(frame.locks[0]?.perfectClear, true);
  assert.deepEqual(frame.outgoingAttacks, [9]);
  assert.equal(player.view.board.rows.every((row) => row === 0), true);
  assert.equal(player.view.backToBackState.difficultClearStreak, 1);
});

test("integer attacks do not consume the rounding RNG", () => {
  const missingColumn = FULL_ROW_MASK ^ (1 << 5);
  let rolls = 0;
  const player = simulation(
    ["I", "O", "T", "L", "J", "S", "Z"],
    createBoard([
      missingColumn,
      missingColumn,
      missingColumn,
      missingColumn
    ]),
    240,
    () => {
      rolls += 1;
      return Number.NaN;
    }
  );

  assert.doesNotThrow(() => player.advanceFrame(1, [
    { kind: "rotate", direction: "cw" },
    { kind: "hardDrop" }
  ]));
  assert.equal(rolls, 0);
});

test("fractional attacks consume exactly one rounding RNG sample", () => {
  const missingPair = FULL_ROW_MASK ^ (1 << 4) ^ (1 << 5);
  let rolls = 0;
  const player = simulation(
    ["O", "O", "T", "L", "J", "S", "Z"],
    createBoard([missingPair, missingPair, missingPair, missingPair]),
    240,
    () => {
      rolls += 1;
      return 0.1;
    }
  );

  player.advanceFrame(1, [{ kind: "hardDrop" }]);
  assert.equal(rolls, 0);
  player.advanceFrame(2, [{ kind: "hardDrop" }]);
  assert.equal(rolls, 1);
});

test("opener cancellation doubles defense without doubling outgoing attack", () => {
  const missingColumn = FULL_ROW_MASK ^ (1 << 5);
  const player = simulation(
    ["I", "O", "T", "L", "J", "S", "Z"],
    createBoard([missingColumn, missingColumn, missingColumn, missingColumn])
  );
  player.queueGarbage({
    packetId: "g1",
    sourcePlayerId: "bob",
    amount: 8,
    appliesAtFrame: 1,
    hole: 3
  });
  const frame = player.advanceFrame(1, [
    { kind: "rotate", direction: "cw" },
    { kind: "hardDrop" }
  ]);

  assert.equal(frame.locks[0]?.cancelledGarbage, 8);
  assert.deepEqual(frame.outgoingAttacks, [5]);
  assert.equal(player.view.pendingGarbage.length, 0);
  assert.equal(player.view.totalAttackSent, 5);
});

test("combo blocking delays garbage on clears and cap applies on a miss", () => {
  const player = simulation(["O", "T", "I", "L", "J", "S", "Z"]);
  player.queueGarbage({
    packetId: "g1",
    sourcePlayerId: "bob",
    amount: 10,
    appliesAtFrame: 1,
    hole: 3
  });
  const frame = player.advanceFrame(1, [{ kind: "hardDrop" }]);

  assert.equal(frame.locks[0]?.lines, 0);
  assert.equal(frame.locks[0]?.appliedGarbageHoles.length, 8);
  assert.equal(player.view.pendingGarbage[0]?.amount, 2);
  assert.equal(player.view.board.garbageRows.slice(0, 8).every(Boolean), true);
  assert.equal(player.view.active?.kind, "T");
});

test("disconnect clearing removes held movement and soft drop", () => {
  const player = simulation(["T", "I", "O", "L", "J", "S", "Z"]);
  player.advanceFrame(1, [
    { kind: "move", direction: "left", pressed: true },
    { kind: "softDrop", pressed: true }
  ]);
  assert.notEqual(player.view.heldInputMask, 0);
  player.clearHeldInput();
  assert.equal(player.view.heldInputMask, 0);
  assert.equal(player.view.dasFrames, 0);
});

test("discrete horizontal actions move once or to the wall", () => {
  const player = simulation(["T", "I", "O", "L", "J", "S", "Z"]);
  const initialX = player.view.active?.x;
  player.advanceFrame(1, [{ kind: "moveStep", direction: "right" }]);
  assert.equal(player.view.active?.x, (initialX as number) + 1);
  assert.equal(player.view.heldInputMask, 0);

  player.advanceFrame(2, [{ kind: "moveToWall", direction: "left" }]);
  assert.equal(player.view.active?.x, 0);
  assert.equal(player.view.heldInputMask, 0);
});

test("discrete drops stop without forcing a lock", () => {
  const player = simulation(["T", "I", "O", "L", "J", "S", "Z"]);
  const initialY = player.view.active?.y;
  const stepped = player.advanceFrame(1, [
    { kind: "softDropStep", cells: 4 }
  ]);
  assert.equal(player.view.active?.y, (initialY as number) - 4);
  assert.equal(stepped.locks.length, 0);
  assert.equal(player.view.piecesPlaced, 0);

  const sonic = player.advanceFrame(2, [{ kind: "sonicDrop" }]);
  assert.equal(sonic.locks.length, 0);
  assert.equal(player.view.piecesPlaced, 0);
  assert.equal(player.view.board.rows.every((row) => row === 0), true);
  assert.equal(player.view.active?.kind, "T");

  const locked = player.advanceFrame(3, [{ kind: "hardDrop" }]);
  assert.equal(locked.locks.length, 1);
  assert.equal(player.view.piecesPlaced, 1);
  assert.equal(player.view.active?.kind, "I");
});

test("clearHeld action removes legacy held input state", () => {
  const player = simulation(["T", "I", "O", "L", "J", "S", "Z"]);
  player.advanceFrame(1, [
    { kind: "move", direction: "left", pressed: true },
    { kind: "softDrop", pressed: true }
  ]);
  assert.notEqual(player.view.heldInputMask, 0);
  player.advanceFrame(2, [{ kind: "clearHeld" }]);
  assert.equal(player.view.heldInputMask, 0);
  assert.equal(player.view.dasFrames, 0);
});
