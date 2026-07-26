import type {
  InputAction
} from "../../../../packages/protocol/src/matchMessages.ts";
import type {
  PlayerConfig
} from "../config/v3/index.ts";
import type {
  InputOutbox
} from "../realtime/InputOutbox.ts";
import { clientFrameAt } from "../realtime/clientFrame.ts";
import {
  HandlingEngine,
  type ExpandedPlayerAction,
  type KeyDownInput,
  type KeyUpInput,
  type PieceSpawnCause
} from "./public.ts";
import { toMatchInputActions } from "./toMatchInputActions.ts";

const MAX_FRAME_EXTRAPOLATION_MS = 100;

export type LocalUiAction = "forfeit" | "retry" | "openChat";

export interface MatchInputControllerOptions {
  readonly config: PlayerConfig;
  readonly outbox: InputOutbox;
  readonly matchStartedAtMs: number;
  readonly clientFrameBase?: number;
  readonly simulationHz: number;
  readonly predict: (
    actions: readonly InputAction[]
  ) => readonly PieceSpawnCause[] | void;
  readonly onUiAction?: (action: LocalUiAction) => void;
}

/**
 * Expands local Handling, predicts first, and sends second. Server ACKs are
 * deliberately absent from this control path and cannot stall input.
 */
export class MatchInputController {
  readonly #engine: HandlingEngine;
  readonly #outbox: InputOutbox;
  readonly #simulationHz: number;
  #serverFrameBase: number;
  #serverFrameAtMs: number;
  readonly #predict: MatchInputControllerOptions["predict"];
  readonly #onUiAction: (action: LocalUiAction) => void;

  constructor(options: MatchInputControllerOptions) {
    this.#engine = new HandlingEngine(options.config, {
      startTimeMs: options.matchStartedAtMs,
      softDropBaseCellsPerSecond: 60
    });
    this.#outbox = options.outbox;
    this.#serverFrameBase = options.clientFrameBase ?? 0;
    this.#serverFrameAtMs = options.matchStartedAtMs;
    this.#simulationHz = options.simulationHz;
    this.#predict = options.predict;
    this.#onUiAction = options.onUiAction ?? (() => undefined);
  }

  keyDown(input: KeyDownInput): void {
    this.#dispatch(input.atMs, this.#engine.keyDown(input));
  }

  keyUp(input: KeyUpInput): void {
    this.#dispatch(input.atMs, this.#engine.keyUp(input));
  }

  advance(atMs: number): void {
    this.#dispatch(atMs, this.#engine.advance(atMs));
  }

  notifyPieceSpawned(
    atMs: number,
    cause: PieceSpawnCause = "input"
  ): void {
    this.#dispatch(atMs, this.#engine.notifyPieceSpawned(atMs, cause));
  }

  synchronizeServerFrame(serverFrame: number, atMs: number): void {
    if (
      !Number.isSafeInteger(serverFrame) ||
      serverFrame < this.#serverFrameBase ||
      !Number.isFinite(atMs)
    ) return;
    this.#serverFrameBase = serverFrame;
    this.#serverFrameAtMs = atMs;
  }

  blur(atMs: number): void {
    this.#engine.blur(atMs);
    this.#send(atMs, [{ kind: "clearHeld" }]);
  }

  #dispatch(
    atMs: number,
    expanded: readonly ExpandedPlayerAction[]
  ): void {
    for (const action of expanded) {
      if (
        action.kind === "forfeit" ||
        action.kind === "retry" ||
        action.kind === "openChat"
      ) {
        this.#onUiAction(action.kind);
      }
    }
    this.#send(atMs, toMatchInputActions(expanded));
  }

  #send(atMs: number, actions: readonly InputAction[]): void {
    if (actions.length === 0) return;
    const prediction = this.#predict(actions);
    const spawnCauses = Array.isArray(prediction) ? prediction : [];
    this.#outbox.enqueue(this.#authoritativeFrameAt(atMs),
      actions
    );
    for (const cause of spawnCauses) {
      this.notifyPieceSpawned(atMs, cause);
    }
  }

  #authoritativeFrameAt(atMs: number): number {
    const cappedAtMs = Math.min(
      Math.max(atMs, this.#serverFrameAtMs),
      this.#serverFrameAtMs + MAX_FRAME_EXTRAPOLATION_MS
    );
    return this.#serverFrameBase +
      clientFrameAt(cappedAtMs, this.#serverFrameAtMs, this.#simulationHz);
  }
}
