import {
  boardAsPlayfield,
  createBoard,
  isPiecePlacementValid,
  type Board
} from "./board.ts";
import {
  INITIAL_BACK_TO_BACK_CHARGE_STATE,
  backToBackChargeStatus
} from "./versusAttack.ts";
import type { BackToBackChargeState } from "./attackTypes.ts";
import {
  pendingGarbageAmount,
  type SimulationGarbagePacket
} from "./garbageQueue.ts";
import { findPieceSpawnPlacement } from "./pieceSpawn.ts";
import type {
  PlayerFrameResult,
  PlayerLockSummary,
  PlayerSimulationOptions,
  PlayerSimulationView,
  PlayerPieceSpawnCause,
  PlayerPieceSpawnEvent,
  SimulationInputAction
} from "./playerSimulationTypes.ts";
import { resolvePlayerLock } from "./playerLockResolution.ts";
import { SIMULATION_MICROS_PER_CELL } from "./simulationRules.ts";
import type { LastSuccessfulRotation } from "./spinDetection.ts";
import { tryRotate } from "./rotation.ts";
import type { ActivePiece, PieceKind } from "./types.ts";

const HELD_LEFT = 1;
const HELD_RIGHT = 2;
const HELD_SOFT_DROP = 4;

export class PlayerSimulation {
  readonly #playerId: string;
  readonly #rules: PlayerSimulationOptions["rules"];
  readonly #pieces: PlayerSimulationOptions["pieces"];
  readonly #nextAttackRoundingRoll: () => number;
  #board: Board;
  #active: ActivePiece | null = null;
  #hold: PieceKind | null = null;
  #canHold = true;
  #combo = -1;
  #backToBack: BackToBackChargeState = INITIAL_BACK_TO_BACK_CHARGE_STATE;
  #piecesPlaced = 0;
  #totalAttackSent = 0;
  #pendingGarbage: readonly SimulationGarbagePacket[] = [];
  #heldMask = 0;
  #horizontal: "left" | "right" | null = null;
  #horizontalFrames = 0;
  #gravityRemainder = 0;
  #lockFrames = 0;
  #lockResets = 0;
  #lastRotation: LastSuccessfulRotation | null = null;
  #toppedOut = false;
  #allowClutchLift = false;
  #frameLocks: PlayerLockSummary[] = [];
  #frameSpawns: PlayerPieceSpawnEvent[] = [];

  constructor(options: PlayerSimulationOptions) {
    if (options.playerId.length < 1 || options.playerId.length > 128) {
      throw new TypeError("Invalid simulation player ID.");
    }
    this.#playerId = options.playerId;
    this.#rules = options.rules;
    this.#pieces = options.pieces;
    this.#nextAttackRoundingRoll = options.nextAttackRoundingRoll;
    this.#board = options.initialBoard ?? createBoard();
    this.#spawn(this.#pieces.draw());
  }

  get view(): PlayerSimulationView {
    return Object.freeze({
      playerId: this.#playerId,
      rules: this.#rules,
      board: this.#board,
      active: this.#active === null ? null : Object.freeze({ ...this.#active }),
      hold: this.#hold,
      next: Object.freeze([...this.#pieces.peek(this.#rules.nextPreviewCount)]),
      pieceCursor: this.#pieces.getCursor(),
      combo: this.#combo,
      backToBackState: this.#backToBack,
      backToBack: backToBackChargeStatus(this.#backToBack).displayedCount,
      piecesPlaced: this.#piecesPlaced,
      totalAttackSent: this.#totalAttackSent,
      pendingGarbage: this.#pendingGarbage,
      heldInputMask: this.#heldMask,
      dasFrames: this.#horizontalFrames,
      lockFrames: this.#lockFrames,
      lockResets: this.#lockResets,
      canHold: this.#canHold,
      toppedOut: this.#toppedOut
    });
  }

  queueGarbage(packet: SimulationGarbagePacket): void {
    if (this.#toppedOut) return;
    pendingGarbageAmount([packet]);
    this.#pendingGarbage = Object.freeze([
      ...this.#pendingGarbage,
      Object.freeze({ ...packet })
    ]);
  }

  clearHeldInput(): void {
    this.#heldMask = 0;
    this.#horizontal = null;
    this.#horizontalFrames = 0;
  }

  advanceFrame(
    serverFrame: number,
    actions: readonly SimulationInputAction[] = []
  ): PlayerFrameResult {
    if (!Number.isSafeInteger(serverFrame) || serverFrame < 1) {
      throw new RangeError("Invalid simulation frame.");
    }
    if (actions.length > 64) throw new RangeError("Too many actions in one frame.");
    const wasToppedOut = this.#toppedOut;
    this.#frameLocks = [];
    this.#frameSpawns = [];
    if (!this.#toppedOut) {
      for (const action of actions) this.#applyAction(action, serverFrame);
      if (!this.#toppedOut && this.#active !== null) {
        this.#repeatHorizontal();
        this.#applyGravity();
        this.#advanceLock(serverFrame);
      }
    }
    const outgoingAttacks = this.#frameLocks.flatMap(
      (locked) => locked.outgoingAttacks
    );
    return Object.freeze({
      serverFrame,
      locks: Object.freeze([...this.#frameLocks]),
      spawns: Object.freeze([...this.#frameSpawns]),
      outgoingAttacks: Object.freeze(outgoingAttacks),
      newlyToppedOut: !wasToppedOut && this.#toppedOut,
      toppedOut: this.#toppedOut
    });
  }

  #applyAction(action: SimulationInputAction, serverFrame: number): void {
    if (action.kind === "clearHeld") {
      this.clearHeldInput();
      return;
    }
    if (this.#active === null || this.#toppedOut) return;
    switch (action.kind) {
      case "move": this.#setHorizontal(action.direction, action.pressed); return;
      case "moveStep": this.#moveHorizontal(action.direction); return;
      case "moveToWall":
        while (this.#moveHorizontal(action.direction)) { /* move to wall */ }
        return;
      case "softDrop":
        this.#heldMask = action.pressed
          ? this.#heldMask | HELD_SOFT_DROP
          : this.#heldMask & ~HELD_SOFT_DROP;
        return;
      case "softDropStep":
        for (
          let cells = action.cells;
          cells > 0 && this.#moveVertical(-1);
          cells -= 1
        ) { /* drop the requested distance */ }
        return;
      case "sonicDrop":
        while (this.#moveVertical(-1)) { /* drop without locking */ }
        return;
      case "rotate": this.#rotate(action.direction); return;
      case "hold": this.#performHold(); return;
      case "hardDrop":
        while (this.#moveVertical(-1)) { /* drop to the floor */ }
        this.#lock(serverFrame, "hardDrop");
        return;
    }
  }

  #setHorizontal(direction: "left" | "right", pressed: boolean): void {
    const bit = direction === "left" ? HELD_LEFT : HELD_RIGHT;
    const oppositeBit = direction === "left" ? HELD_RIGHT : HELD_LEFT;
    const alreadyHeld = (this.#heldMask & bit) !== 0;
    this.#heldMask = pressed ? this.#heldMask | bit : this.#heldMask & ~bit;
    if (pressed && !alreadyHeld) {
      this.#horizontal = direction;
      this.#horizontalFrames = 0;
      this.#moveHorizontal(direction);
      return;
    }
    if (!pressed && this.#horizontal === direction) {
      if ((this.#heldMask & oppositeBit) !== 0) {
        this.#horizontal = direction === "left" ? "right" : "left";
        this.#horizontalFrames = 0;
        this.#moveHorizontal(this.#horizontal);
      } else {
        this.#horizontal = null;
        this.#horizontalFrames = 0;
      }
    }
  }

  #repeatHorizontal(): void {
    if (this.#horizontal === null || this.#active === null) return;
    this.#horizontalFrames += 1;
    if (this.#horizontalFrames < this.#rules.dasFrames) return;
    if (this.#rules.arrFrames === 0) {
      while (this.#moveHorizontal(this.#horizontal)) { /* instant ARR */ }
      return;
    }
    if (
      (this.#horizontalFrames - this.#rules.dasFrames) %
        this.#rules.arrFrames === 0
    ) {
      this.#moveHorizontal(this.#horizontal);
    }
  }

  #moveHorizontal(direction: "left" | "right"): boolean {
    if (this.#active === null) return false;
    const candidate = {
      ...this.#active,
      x: this.#active.x + (direction === "left" ? -1 : 1)
    };
    return this.#acceptManipulation(candidate, null);
  }

  #moveVertical(deltaY: -1): boolean {
    if (this.#active === null) return false;
    const candidate = { ...this.#active, y: this.#active.y + deltaY };
    if (!isPiecePlacementValid(this.#board, candidate)) return false;
    this.#active = candidate;
    return true;
  }

  #rotate(direction: "cw" | "ccw" | "180"): void {
    if (this.#active === null) return;
    const result = tryRotate(
      boardAsPlayfield(this.#board), this.#active, direction
    );
    if (!result.success) return;
    this.#acceptManipulation(result.piece, {
      direction,
      kickIndex: result.kickIndex
    });
  }

  #acceptManipulation(
    candidate: ActivePiece,
    rotation: LastSuccessfulRotation | null
  ): boolean {
    if (this.#active === null || !isPiecePlacementValid(this.#board, candidate)) {
      return false;
    }
    const wasGrounded = !isPiecePlacementValid(this.#board, {
      ...this.#active, y: this.#active.y - 1
    });
    this.#active = candidate;
    this.#lastRotation = rotation;
    if (wasGrounded && this.#lockResets < this.#rules.lockResetLimit) {
      this.#lockFrames = 0;
      this.#lockResets += 1;
    }
    return true;
  }

  #applyGravity(): void {
    const soft = (this.#heldMask & HELD_SOFT_DROP) !== 0;
    const rate = soft
      ? Math.max(
          this.#rules.gravityMicrosPerSecond,
          this.#rules.softDropMicrosPerSecond
        )
      : this.#rules.gravityMicrosPerSecond;
    this.#gravityRemainder += rate;
    const threshold =
      this.#rules.tickRateHz * SIMULATION_MICROS_PER_CELL;
    let cells = Math.floor(this.#gravityRemainder / threshold);
    this.#gravityRemainder %= threshold;
    cells = Math.min(cells, 40);
    while (cells > 0 && this.#moveVertical(-1)) cells -= 1;
  }

  #advanceLock(serverFrame: number): void {
    if (this.#active === null) return;
    const grounded = !isPiecePlacementValid(this.#board, {
      ...this.#active, y: this.#active.y - 1
    });
    if (!grounded) {
      this.#lockFrames = 0;
      return;
    }
    this.#lockFrames += 1;
    if (this.#lockFrames >= this.#rules.lockDelayFrames) {
      this.#lock(serverFrame, "automatic");
    }
  }

  #performHold(): void {
    if (!this.#canHold || this.#active === null) return;
    const current = this.#active.kind;
    const replacement = this.#hold ?? this.#pieces.draw();
    this.#hold = current;
    this.#canHold = false;
    this.#spawn(
      replacement,
      false,
      "hold",
      this.#allowClutchLift
    );
  }

  #lock(
    serverFrame: number,
    spawnCause: Exclude<PlayerPieceSpawnCause, "hold">
  ): void {
    const piece = this.#active;
    if (piece === null) return;
    const resolution = resolvePlayerLock({
      board: this.#board,
      piece,
      lastRotation: this.#lastRotation,
      combo: this.#combo,
      backToBack: this.#backToBack,
      piecesPlacedBeforeLock: this.#piecesPlaced,
      totalAttackSent: this.#totalAttackSent,
      pendingGarbage: this.#pendingGarbage,
      serverFrame,
      garbageCap: this.#rules.garbageCap,
      nextAttackRoundingRoll: this.#nextAttackRoundingRoll
    });
    this.#board = resolution.board;
    this.#combo = resolution.combo;
    this.#backToBack = resolution.backToBack;
    this.#totalAttackSent = resolution.totalAttackSent;
    this.#pendingGarbage = resolution.pendingGarbage;
    this.#toppedOut = resolution.toppedOut;
    this.#piecesPlaced += 1;
    this.#frameLocks.push(resolution.summary);
    this.#allowClutchLift = resolution.summary.lines > 0;
    if (!this.#toppedOut) {
      this.#spawn(
        this.#pieces.draw(),
        true,
        spawnCause,
        this.#allowClutchLift
      );
    }
  }

  #spawn(
    kind: PieceKind,
    resetHold = true,
    cause?: PlayerPieceSpawnCause,
    allowClutchLift = false
  ): void {
    const placement = findPieceSpawnPlacement({
      board: this.#board,
      kind,
      spawnX: this.#rules.spawnX,
      spawnY: this.#rules.spawnY,
      allowClutchLift
    });
    this.#active = placement?.piece ?? null;
    this.#toppedOut = this.#active === null;
    if (resetHold) this.#canHold = true;
    if (cause !== undefined && this.#active !== null) {
      this.#frameSpawns.push(Object.freeze({
        cause,
        piece: kind,
        liftedRows: placement?.liftedRows ?? 0
      }));
    }
    this.#gravityRemainder = 0;
    this.#lockFrames = 0;
    this.#lockResets = 0;
    this.#lastRotation = null;
  }

}
