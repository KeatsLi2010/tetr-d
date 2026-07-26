import {
  frameTenthsToMs,
  type PlayerActionName,
  type PlayerConfig
} from "../config/playerConfigTypes.ts";
import { normalizePlayerConfig } from "../config/playerConfig.ts";
import {
  FORFEIT,
  HARD_DROP,
  HOLD,
  OPEN_CHAT,
  RETRY,
  SOFT_DROP_TO_FLOOR,
  rotateAction,
  shiftAction,
  softDropCells,
  type ExpandedPlayerAction,
  type ShiftDirection
} from "./playerActions.ts";
import { indexPlayerBindings } from "./playerKeyBindings.ts";

const MAX_EMISSIONS_PER_ADVANCE = 512;
export const SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_60HZ_FRAMES = 2;
export const SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS =
  SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_60HZ_FRAMES * (1_000 / 60);
export type PieceSpawnCause =
  "automatic" | "hardDrop" | "hold" | "input";

export interface HandlingEngineOptions {
  readonly startTimeMs?: number;
  /** Base rate used by finite SDF values; defaults to one cell per second. */
  readonly softDropBaseCellsPerSecond?: number;
}

export interface KeyDownInput {
  readonly code: string;
  readonly atMs: number;
  readonly repeat?: boolean;
}

export interface KeyUpInput {
  readonly code: string;
  readonly atMs: number;
}

function finiteTime(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Input time must be a nonnegative finite number.");
  }
}

function directionOf(
  action: PlayerActionName
): ShiftDirection | null {
  if (action === "moveLeft") return "left";
  if (action === "moveRight") return "right";
  return null;
}

export class HandlingEngine {
  readonly #config: PlayerConfig;
  readonly #bindingIndex: ReadonlyMap<string, readonly PlayerActionName[]>;
  readonly #softDropBaseRate: number;
  readonly #pressedCodes = new Set<string>();
  readonly #heldCounts = new Map<PlayerActionName, number>();
  readonly #directionOrder: ShiftDirection[] = [];
  #nowMs: number;
  #activeDirection: ShiftDirection | null = null;
  #horizontalCharged = false;
  #nextHorizontalAt = Number.POSITIVE_INFINITY;
  #nextSoftDropAt = Number.POSITIVE_INFINITY;
  #hardDropBlockedUntilMs = Number.NEGATIVE_INFINITY;

  constructor(config: PlayerConfig, options: HandlingEngineOptions = {}) {
    const normalized = normalizePlayerConfig(config);
    if (normalized === null) throw new TypeError("Invalid player config.");
    const startTimeMs = options.startTimeMs ?? 0;
    const baseRate = options.softDropBaseCellsPerSecond ?? 1;
    finiteTime(startTimeMs);
    if (!Number.isFinite(baseRate) || baseRate <= 0) {
      throw new RangeError("Invalid finite soft-drop base rate.");
    }
    this.#config = normalized;
    this.#bindingIndex = indexPlayerBindings(normalized.bindings);
    this.#softDropBaseRate = baseRate;
    this.#nowMs = startTimeMs;
  }

  get activeDirection(): ShiftDirection | null {
    return this.#activeDirection;
  }

  keyDown(input: KeyDownInput): readonly ExpandedPlayerAction[] {
    const output = [...this.advance(input.atMs)];
    if (input.repeat === true || this.#pressedCodes.has(input.code)) {
      return Object.freeze(output);
    }
    this.#pressedCodes.add(input.code);
    for (const action of this.#bindingIndex.get(input.code) ?? []) {
      const count = this.#heldCounts.get(action) ?? 0;
      this.#heldCounts.set(action, count + 1);
      if (count === 0) this.#pressAction(action, output);
    }
    return Object.freeze(output);
  }

  keyUp(input: KeyUpInput): readonly ExpandedPlayerAction[] {
    const output = [...this.advance(input.atMs)];
    if (!this.#pressedCodes.delete(input.code)) return Object.freeze(output);
    for (const action of this.#bindingIndex.get(input.code) ?? []) {
      const count = this.#heldCounts.get(action) ?? 0;
      if (count <= 1) {
        this.#heldCounts.delete(action);
        this.#releaseAction(action, output);
      } else {
        this.#heldCounts.set(action, count - 1);
      }
    }
    return Object.freeze(output);
  }

  advance(toMs: number): readonly ExpandedPlayerAction[] {
    this.#assertForwardTime(toMs);
    const output: ExpandedPlayerAction[] = [];
    let emitted = 0;
    while (emitted < MAX_EMISSIONS_PER_ADVANCE) {
      const due = Math.min(this.#nextHorizontalAt, this.#nextSoftDropAt);
      if (due > toMs) break;
      this.#nowMs = due;
      const horizontalDue = this.#nextHorizontalAt === due;
      const softDropDue = this.#nextSoftDropAt === due;
      if (softDropDue && this.#config.handling.preferSoftDrop) {
        this.#emitSoftDrop(output);
        emitted += 1;
      }
      if (horizontalDue) {
        this.#emitHorizontal(output);
        emitted += 1;
      }
      if (softDropDue && !this.#config.handling.preferSoftDrop) {
        this.#emitSoftDrop(output);
        emitted += 1;
      }
    }
    if (emitted === MAX_EMISSIONS_PER_ADVANCE) {
      this.#skipBacklog(toMs);
    }
    this.#nowMs = toMs;
    return Object.freeze(output);
  }

  notifyPieceSpawned(
    atMs: number,
    cause: PieceSpawnCause = "input"
  ): readonly ExpandedPlayerAction[] {
    this.#assertForwardTime(atMs);
    this.#cutDasAt(atMs);
    const output = [...this.advance(atMs)];
    this.#hardDropBlockedUntilMs =
      cause === "automatic" && this.#config.handling.safeLock
        ? atMs + SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS
        : Number.NEGATIVE_INFINITY;
    this.#restartHeldSoftDrop(output);
    return Object.freeze(output);
  }

  blur(atMs: number): void {
    this.#assertForwardTime(atMs);
    this.#nowMs = atMs;
    this.#pressedCodes.clear();
    this.#heldCounts.clear();
    this.#directionOrder.length = 0;
    this.#activeDirection = null;
    this.#horizontalCharged = false;
    this.#nextHorizontalAt = Number.POSITIVE_INFINITY;
    this.#nextSoftDropAt = Number.POSITIVE_INFINITY;
  }

  #pressAction(
    action: PlayerActionName,
    output: ExpandedPlayerAction[]
  ): void {
    const direction = directionOf(action);
    if (direction !== null) {
      this.#directionOrder.push(direction);
      this.#selectDirection(direction, output);
      return;
    }
    if (action === "softDrop") {
      this.#restartHeldSoftDrop(output);
      return;
    }
    if (action === "hardDrop") {
      if (this.#nowMs < this.#hardDropBlockedUntilMs) return;
      output.push(HARD_DROP);
      return;
    }
    if (action === "hold") {
      output.push(HOLD);
      return;
    }
    if (action === "rotateCW") output.push(rotateAction("cw"));
    if (action === "rotateCCW") output.push(rotateAction("ccw"));
    if (action === "rotate180") output.push(rotateAction("180"));
    if (action.startsWith("rotate")) this.#cutDasForManipulation(output);
    if (action === "forfeit") output.push(FORFEIT);
    if (action === "retry") output.push(RETRY);
    if (action === "openChat") output.push(OPEN_CHAT);
  }

  #releaseAction(
    action: PlayerActionName,
    output: ExpandedPlayerAction[]
  ): void {
    const direction = directionOf(action);
    if (direction !== null) {
      const index = this.#directionOrder.lastIndexOf(direction);
      if (index >= 0) this.#directionOrder.splice(index, 1);
      if (this.#activeDirection === direction) {
        this.#selectDirection(
          this.#directionOrder.at(-1) ?? null,
          output
        );
      }
    }
    if (action === "softDrop") {
      this.#nextSoftDropAt = Number.POSITIVE_INFINITY;
    }
  }

  #selectDirection(
    direction: ShiftDirection | null,
    output: ExpandedPlayerAction[]
  ): void {
    if (direction === this.#activeDirection) return;
    const preserved = this.#activeDirection !== null &&
      !this.#config.handling.dasCancellation;
    this.#activeDirection = direction;
    if (direction === null) {
      this.#horizontalCharged = false;
      this.#nextHorizontalAt = Number.POSITIVE_INFINITY;
      return;
    }
    output.push(shiftAction(direction, "step"));
    if (!preserved) {
      this.#horizontalCharged = false;
      this.#nextHorizontalAt =
        this.#nowMs + frameTenthsToMs(
          this.#config.handling.dasFrameTenths
        );
    } else if (
      this.#horizontalCharged &&
      this.#config.handling.arrFrameTenths === 0
    ) {
      this.#nextHorizontalAt = this.#nowMs;
    }
    this.#drainCurrent(output);
  }

  #emitHorizontal(output: ExpandedPlayerAction[]): void {
    const direction = this.#activeDirection;
    if (direction === null) {
      this.#nextHorizontalAt = Number.POSITIVE_INFINITY;
      return;
    }
    this.#horizontalCharged = true;
    const arr = this.#config.handling.arrFrameTenths;
    if (arr === 0) {
      output.push(shiftAction(direction, "wall"));
      this.#nextHorizontalAt = Number.POSITIVE_INFINITY;
    } else {
      output.push(shiftAction(direction, "step"));
      this.#nextHorizontalAt += frameTenthsToMs(arr);
    }
  }

  #cutDasForManipulation(output: ExpandedPlayerAction[]): void {
    this.#cutDasAt(this.#nowMs);
    this.#drainCurrent(output);
  }

  #cutDasAt(atMs: number): void {
    if (this.#activeDirection === null) return;
    const dcd = frameTenthsToMs(
      this.#config.handling.dcdFrameTenths
    );
    if (this.#horizontalCharged &&
        this.#config.handling.arrFrameTenths === 0) {
      this.#nextHorizontalAt = atMs + dcd;
    } else if (Number.isFinite(this.#nextHorizontalAt)) {
      this.#nextHorizontalAt =
        Math.max(this.#nextHorizontalAt, atMs) + dcd;
    }
  }

  #restartHeldSoftDrop(output: ExpandedPlayerAction[]): void {
    if (!this.#heldCounts.has("softDrop")) return;
    if (this.#config.handling.sdf === "sonic") {
      output.push(SOFT_DROP_TO_FLOOR);
      this.#nextSoftDropAt = Number.POSITIVE_INFINITY;
    } else {
      this.#nextSoftDropAt = this.#nowMs + this.#softDropIntervalMs();
    }
  }

  #softDropIntervalMs(): number {
    const sdf = this.#config.handling.sdf;
    return sdf === "sonic"
      ? Number.POSITIVE_INFINITY
      : 1_000 / (sdf * this.#softDropBaseRate);
  }

  #emitSoftDrop(output: ExpandedPlayerAction[]): void {
    this.#appendSoftDrop(output, 1);
    this.#nextSoftDropAt += this.#softDropIntervalMs();
  }

  #appendSoftDrop(
    output: ExpandedPlayerAction[],
    cells: number
  ): void {
    const previous = output.at(-1);
    if (
      previous?.kind === "softDrop" &&
      previous.mode === "cells" &&
      previous.cells + cells <= 40
    ) {
      output[output.length - 1] = softDropCells(previous.cells + cells);
    } else {
      output.push(softDropCells(cells));
    }
  }

  #drainCurrent(output: ExpandedPlayerAction[]): void {
    if (this.#nextHorizontalAt <= this.#nowMs) {
      this.#emitHorizontal(output);
    }
  }

  #skipBacklog(toMs: number): void {
    if (Number.isFinite(this.#nextHorizontalAt)) {
      const arr = this.#config.handling.arrFrameTenths;
      this.#nextHorizontalAt = arr === 0
        ? Number.POSITIVE_INFINITY
        : toMs + frameTenthsToMs(arr);
    }
    if (Number.isFinite(this.#nextSoftDropAt)) {
      this.#nextSoftDropAt = toMs + this.#softDropIntervalMs();
    }
  }

  #assertForwardTime(value: number): void {
    finiteTime(value);
    if (value < this.#nowMs) {
      throw new RangeError("Handling engine time cannot move backwards.");
    }
  }
}

