import {
  PlayerSimulation,
  createPlayerSimulationRules,
  type Board,
  type PlayerPieceSpawnCause,
  type PlayerSimulationRuleOverrides,
  type PlayerLockSummary,
  type SevenBagSeed,
  type SimulationInputAction
} from "@tetr-d/game-core";

import type {
  GameSession,
  GameSessionListener,
  GameSessionPhase,
  GameSessionSnapshot,
  GameSessionStats
} from "../sessionTypes.ts";
import { LocalSevenBagPieceSource } from "./LocalSevenBagPieceSource.ts";
import { createDeterministicAttackRng } from "./attackRandom.ts";

export const SOLO_TICK_RATE_HZ = 240;
export const SOLO_DEFAULT_MAX_CATCH_UP_TICKS = 240;
const TICK_DURATION_MS = 1_000 / SOLO_TICK_RATE_HZ;
const MAX_ACTIONS_PER_TICK = 64;
const TIME_EPSILON_MS = 1e-7;

export type SoloTickActionSource = (
  tickTimeMs: number,
  frame: number
) => readonly SimulationInputAction[];

export interface SoloGameSessionOptions {
  readonly seed: SevenBagSeed;
  /** Supplies a fresh seed for each explicit restart when provided. */
  readonly nextSeed?: () => SevenBagSeed;
  readonly attackSeed?: number;
  readonly playerId?: string;
  readonly now?: () => number;
  readonly ruleOverrides?: PlayerSimulationRuleOverrides;
  readonly initialBoard?: Board;
  /** Bounds synchronous recovery after a stalled or backgrounded page. */
  readonly maxCatchUpTicks?: number;
  /** Lets the input clock drop its own stale repeat backlog at the same time. */
  readonly onClockReanchored?: (nowMs: number) => void;
  /** Reports each successful post-start spawn after simulation accepts it. */
  readonly onPieceSpawned?: (
    atMs: number,
    frame: number,
    cause: PlayerPieceSpawnCause
  ) => void;
  /** Reports authoritative local lock summaries for optional local feedback. */
  readonly onLock?: (atMs: number, frame: number, lock: PlayerLockSummary) => void;
  /**
   * Called once per 240 Hz tick, even when advanceTo is driven by a slower
   * requestAnimationFrame cadence. This is where HandlingEngine.advance goes.
   */
  readonly actionsForTick?: SoloTickActionSource;
}

export class SoloGameSession implements GameSession {
  readonly #options: SoloGameSessionOptions;
  readonly #now: () => number;
  readonly #maxCatchUpTicks: number;
  readonly #listeners = new Set<GameSessionListener>();
  #seed: SevenBagSeed;
  #simulation: PlayerSimulation;
  #phase: GameSessionPhase = "idle";
  #frame = 0;
  #lines = 0;
  #lastNowMs: number | null = null;
  #accumulatedMs = 0;
  #queuedActions: SimulationInputAction[] = [];
  #disposed = false;

  constructor(options: SoloGameSessionOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => globalThis.performance.now());
    this.#maxCatchUpTicks =
      options.maxCatchUpTicks ?? SOLO_DEFAULT_MAX_CATCH_UP_TICKS;
    if (
      !Number.isSafeInteger(this.#maxCatchUpTicks) ||
      this.#maxCatchUpTicks < 1
    ) throw new RangeError("Catch-up tick limit must be a positive integer.");
    this.#seed = options.seed;
    this.#simulation = this.#createSimulation();
  }

  get snapshot(): GameSessionSnapshot {
    return this.#makeSnapshot();
  }

  start(): GameSessionSnapshot {
    this.#assertLive();
    if (this.#phase !== "idle") return this.snapshot;
    this.#lastNowMs = this.#readNow();
    this.#phase = this.#simulation.view.toppedOut ? "ended" : "playing";
    return this.#publish();
  }

  pause(): GameSessionSnapshot {
    this.#assertLive();
    if (this.#phase !== "playing") return this.snapshot;
    this.advanceTo(this.#readNow());
    if (this.#phase === "playing") {
      this.#phase = "paused";
      this.#queuedActions = [];
      return this.#publish();
    }
    return this.snapshot;
  }

  resume(): GameSessionSnapshot {
    this.#assertLive();
    if (this.#phase !== "paused") return this.snapshot;
    this.#lastNowMs = this.#readNow();
    this.#phase = "playing";
    return this.#publish();
  }

  restart(): GameSessionSnapshot {
    this.#assertLive();
    const nextSeed = this.#options.nextSeed?.() ?? this.#seed;
    const nextSimulation = this.#createSimulation(nextSeed);
    this.#seed = nextSeed;
    this.#simulation = nextSimulation;
    this.#phase = this.#simulation.view.toppedOut ? "ended" : "playing";
    this.#frame = 0;
    this.#lines = 0;
    this.#accumulatedMs = 0;
    this.#queuedActions = [];
    this.#lastNowMs = this.#readNow();
    return this.#publish();
  }

  advanceTo(nowMs = this.#readNow()): GameSessionSnapshot {
    this.#assertLive();
    this.#assertTime(nowMs);
    if (this.#phase !== "playing") {
      if (this.#phase === "paused") this.#lastNowMs = nowMs;
      return this.snapshot;
    }

    const previous = this.#lastNowMs;
    if (previous === null) throw new Error("Playing session has no time anchor.");
    if (nowMs < previous) throw new RangeError("Session time cannot move backward.");
    this.#accumulatedMs += nowMs - previous;
    this.#lastNowMs = nowMs;
    let changed = false;
    let ticksAdvanced = 0;

    while (
      ticksAdvanced < this.#maxCatchUpTicks &&
      this.#accumulatedMs + TIME_EPSILON_MS >= TICK_DURATION_MS
    ) {
      this.#accumulatedMs -= TICK_DURATION_MS;
      if (this.#accumulatedMs < 0) this.#accumulatedMs = 0;
      const tickTimeMs = nowMs - this.#accumulatedMs;
      const toppedOut = this.#advanceTick(tickTimeMs);
      changed = true;
      ticksAdvanced += 1;
      if (toppedOut) {
        this.#accumulatedMs = 0;
        break;
      }
    }
    if (this.#accumulatedMs + TIME_EPSILON_MS >= TICK_DURATION_MS) {
      // Re-anchor at now instead of blocking the UI on stale wall-clock debt.
      this.#accumulatedMs = 0;
      this.#options.onClockReanchored?.(nowMs);
    }
    return changed ? this.#publish() : this.snapshot;
  }

  dispatch(action: SimulationInputAction): void {
    this.#assertLive();
    if (this.#phase !== "playing") return;
    if (this.#queuedActions.length >= MAX_ACTIONS_PER_TICK) {
      throw new RangeError("Too many queued actions before the next tick.");
    }
    this.#queuedActions.push(action);
  }

  subscribe(listener: GameSessionListener): () => void {
    this.#assertLive();
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#queuedActions = [];
    this.#simulation.clearHeldInput();
  }

  #advanceTick(tickTimeMs: number): boolean {
    const generated = this.#options.actionsForTick?.(
      tickTimeMs,
      this.#frame + 1
    ) ?? [];
    const actions = [...this.#queuedActions, ...generated];
    this.#queuedActions = [];
    if (actions.length > MAX_ACTIONS_PER_TICK) {
      throw new RangeError("Too many actions generated for one tick.");
    }
    this.#frame += 1;
    const result = this.#simulation.advanceFrame(this.#frame, actions);
    for (const lock of result.locks) {
      this.#lines += lock.lines;
      this.#options.onLock?.(tickTimeMs, this.#frame, lock);
    }
    for (const spawn of result.spawns) {
      this.#options.onPieceSpawned?.(
        tickTimeMs,
        this.#frame,
        spawn.cause
      );
    }
    if (result.toppedOut) this.#phase = "ended";
    return result.toppedOut;
  }

  #createSimulation(seed = this.#seed): PlayerSimulation {
    return new PlayerSimulation({
      playerId: this.#options.playerId ?? "solo",
      rules: createPlayerSimulationRules(
        SOLO_TICK_RATE_HZ,
        this.#options.ruleOverrides
      ),
      pieces: new LocalSevenBagPieceSource(seed),
      nextAttackRoundingRoll: createDeterministicAttackRng(
        seed,
        this.#options.attackSeed
      ),
      ...(this.#options.initialBoard === undefined
        ? {}
        : { initialBoard: this.#options.initialBoard })
    });
  }

  #makeStats(): GameSessionStats {
    const elapsedMs = this.#frame * TICK_DURATION_MS;
    const pieces = this.#simulation.view.piecesPlaced;
    const attack = this.#simulation.view.totalAttackSent;
    return Object.freeze({
      elapsedMs,
      lines: this.#lines,
      pieces,
      attack,
      pps: elapsedMs === 0 ? 0 : pieces * 1_000 / elapsedMs,
      apm: elapsedMs === 0 ? 0 : attack * 60_000 / elapsedMs
    });
  }

  #makeSnapshot(): GameSessionSnapshot {
    return Object.freeze({
      phase: this.#phase,
      tickRateHz: SOLO_TICK_RATE_HZ,
      frame: this.#frame,
      player: this.#simulation.view,
      stats: this.#makeStats()
    });
  }

  #publish(): GameSessionSnapshot {
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
    return snapshot;
  }

  #readNow(): number {
    const value = this.#now();
    this.#assertTime(value);
    return value;
  }

  #assertTime(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError("Session time must be a nonnegative finite number.");
    }
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error("Game session is disposed.");
  }
}
