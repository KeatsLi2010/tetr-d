import type { SimulationInputAction } from "@tetr-d/game-core";

import type {
  PlayerConfig
} from "../../config/v3/index.ts";
import {
  HandlingEngine,
  type ExpandedPlayerAction,
  type KeyDownInput,
  type KeyUpInput
} from "../../input/public.ts";

export type GameInputCommand = "forfeit" | "retry" | "openChat";
export type GamePieceSpawnCause =
  "automatic" | "hardDrop" | "hold" | "input";

export interface GameHandlingControllerOptions {
  readonly startTimeMs?: number;
  readonly softDropBaseCellsPerSecond?: number;
  readonly onCommand?: (command: GameInputCommand) => void;
}

function isCommand(
  action: ExpandedPlayerAction
): action is Extract<
  ExpandedPlayerAction,
  { readonly kind: GameInputCommand }
> {
  return (
    action.kind === "forfeit" ||
    action.kind === "retry" ||
    action.kind === "openChat"
  );
}

function simulationAction(
  action: Exclude<
    ExpandedPlayerAction,
    { readonly kind: GameInputCommand }
  >
): SimulationInputAction {
  if (action.kind === "shift") {
    return action.mode === "wall"
      ? { kind: "moveToWall", direction: action.direction }
      : { kind: "moveStep", direction: action.direction };
  }
  if (action.kind === "softDrop") {
    return action.mode === "floor"
      ? { kind: "sonicDrop" }
      : { kind: "softDropStep", cells: action.cells };
  }
  if (action.kind === "hardDrop") return { kind: "hardDrop" };
  if (action.kind === "hold") return { kind: "hold" };
  return { kind: "rotate", direction: action.direction };
}

/**
 * Bridges wall-clock keyboard handling to a fixed-step local simulation.
 *
 * Keyboard events advance Handling to their event time and cache concrete
 * actions. The fixed-step driver drains those actions with actionsForTick(),
 * so DAS/ARR repeats remain distributed across logical ticks instead of being
 * compressed into a render frame.
 */
export class GameHandlingController {
  readonly #engine: HandlingEngine;
  readonly #onCommand: (command: GameInputCommand) => void;
  readonly #pendingActions: SimulationInputAction[] = [];
  #lastTimeMs: number;

  constructor(
    config: PlayerConfig,
    options: GameHandlingControllerOptions = {}
  ) {
    const startTimeMs = options.startTimeMs ?? 0;
    this.#engine = new HandlingEngine(config, {
      startTimeMs,
      softDropBaseCellsPerSecond:
        options.softDropBaseCellsPerSecond ?? 60
    });
    this.#onCommand = options.onCommand ?? (() => undefined);
    this.#lastTimeMs = startTimeMs;
  }

  keyDown(input: KeyDownInput): readonly GameInputCommand[] {
    this.#assertForwardTime(input.atMs);
    const commands = this.#ingest(this.#engine.keyDown(input));
    this.#lastTimeMs = input.atMs;
    return commands;
  }

  keyUp(input: KeyUpInput): readonly GameInputCommand[] {
    this.#assertForwardTime(input.atMs);
    const commands = this.#ingest(this.#engine.keyUp(input));
    this.#lastTimeMs = input.atMs;
    return commands;
  }

  actionsForTick(tickTimeMs: number): readonly SimulationInputAction[] {
    this.#assertForwardTime(tickTimeMs);
    const pieceChangePending = this.#pendingActions.some(
      (action) => action.kind === "hardDrop" || action.kind === "hold"
    );
    if (!pieceChangePending) {
      this.#ingest(this.#engine.advance(tickTimeMs));
    }
    this.#lastTimeMs = tickTimeMs;
    const actions = Object.freeze([...this.#pendingActions]);
    this.#pendingActions.length = 0;
    return actions;
  }

  notifyPieceSpawned(
    atMs: number,
    cause: GamePieceSpawnCause = "input"
  ): readonly GameInputCommand[] {
    this.#assertForwardTime(atMs);
    const commands = this.#ingest(
      this.#engine.notifyPieceSpawned(atMs, cause)
    );
    this.#lastTimeMs = atMs;
    return commands;
  }

  blur(atMs: number): void {
    this.clear(atMs);
  }

  clear(atMs: number): void {
    this.#assertForwardTime(atMs);
    this.#engine.blur(atMs);
    this.#lastTimeMs = atMs;
    this.#pendingActions.length = 0;
  }

  #ingest(
    expanded: readonly ExpandedPlayerAction[]
  ): readonly GameInputCommand[] {
    const commands: GameInputCommand[] = [];
    for (const action of expanded) {
      if (isCommand(action)) {
        commands.push(action.kind);
        this.#onCommand(action.kind);
      } else {
        this.#pendingActions.push(simulationAction(action));
      }
    }
    return Object.freeze(commands);
  }

  #assertForwardTime(value: number): void {
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value < this.#lastTimeMs
    ) {
      throw new RangeError(
        "Game handling time must be finite and never move backwards."
      );
    }
  }
}
