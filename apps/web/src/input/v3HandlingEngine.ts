import {
  normalizePlayerConfig,
  type PlayerConfig
} from "../config/v3/model.ts";
import type {
  PlayerConfig as EnginePlayerConfig
} from "../config/playerConfigTypes.ts";
import {
  HandlingEngine as CoreHandlingEngine,
  SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_60HZ_FRAMES,
  SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS,
  type HandlingEngineOptions,
  type KeyDownInput,
  type KeyUpInput,
  type PieceSpawnCause
} from "./handlingEngine.ts";
import type {
  ExpandedPlayerAction,
  ShiftDirection
} from "./playerActions.ts";

export type {
  HandlingEngineOptions,
  KeyDownInput,
  KeyUpInput,
  PieceSpawnCause
};
export {
  SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_60HZ_FRAMES,
  SAFE_LOCK_AFTER_AUTOMATIC_SPAWN_MS
};

function engineConfig(config: PlayerConfig): EnginePlayerConfig {
  return {
    version: 2,
    bindings: config.bindings,
    handling: {
      arrFrameTenths: config.handling.arrFrameTenths,
      dasFrameTenths: config.handling.dasFrameTenths,
      dcdFrameTenths: config.handling.dcdFrameTenths,
      sdf: config.handling.sdf,
      dasCancellation: config.handling.dasCancellation,
      safeLock: config.handling.safeLock,
      preferSoftDrop: config.handling.preferSoftDrop,
      irs: config.handling.irs !== "off",
      ihs: config.handling.ihs !== "off"
    }
  };
}

/**
 * IRS/IHS modes are intentionally retained for the future piece-generation
 * controller; this engine currently expands active-piece keyboard handling.
 */
export class HandlingEngine {
  readonly #core: CoreHandlingEngine;

  constructor(config: PlayerConfig, options: HandlingEngineOptions = {}) {
    const normalized = normalizePlayerConfig(config);
    if (normalized === null) throw new TypeError("Invalid player config.");
    this.#core = new CoreHandlingEngine(engineConfig(normalized), options);
  }

  get activeDirection(): ShiftDirection | null {
    return this.#core.activeDirection;
  }

  keyDown(input: KeyDownInput): readonly ExpandedPlayerAction[] {
    return this.#core.keyDown(input);
  }

  keyUp(input: KeyUpInput): readonly ExpandedPlayerAction[] {
    return this.#core.keyUp(input);
  }

  advance(toMs: number): readonly ExpandedPlayerAction[] {
    return this.#core.advance(toMs);
  }

  notifyPieceSpawned(
    atMs: number,
    cause: PieceSpawnCause = "input"
  ): readonly ExpandedPlayerAction[] {
    return this.#core.notifyPieceSpawned(atMs, cause);
  }

  blur(atMs: number): void {
    this.#core.blur(atMs);
  }
}

