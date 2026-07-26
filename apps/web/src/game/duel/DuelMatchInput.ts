import type {
  InputAction,
  MatchClientMessage
} from "@tetr-d/protocol";

import type { PlayerConfig } from "../../config/v3/index.ts";
import { MatchInputController } from "../../input/MatchInputController.ts";
import type { PieceSpawnCause } from "../../input/public.ts";
import {
  InputOutbox,
  type MatchInputMessage
} from "../../realtime/InputOutbox.ts";

export interface DuelMatchInputOptions {
  readonly config: PlayerConfig;
  readonly matchId: string;
  readonly inputEpoch: number;
  readonly serverFrame: number;
  readonly simulationHz: number;
  readonly send: (message: MatchClientMessage) => void;
  readonly predict: (
    actions: readonly InputAction[]
  ) => readonly PieceSpawnCause[] | void;
  readonly onForfeit: () => void;
}

function configuredCodes(config: PlayerConfig): ReadonlySet<string> {
  return new Set(Object.values(config.bindings).flat());
}

export class DuelMatchInput {
  readonly #outbox: InputOutbox;
  readonly #controller: MatchInputController;
  readonly #codes: ReadonlySet<string>;
  readonly #keyDown: (event: KeyboardEvent) => void;
  readonly #keyUp: (event: KeyboardEvent) => void;
  readonly #blur: () => void;
  #animationFrame = 0;
  #disposed = false;

  constructor(options: DuelMatchInputOptions) {
    const startedAtMs = performance.now();
    this.#outbox = new InputOutbox({
      matchId: options.matchId,
      inputEpoch: options.inputEpoch,
      send: (message: MatchInputMessage) => options.send(message)
    });
    this.#controller = new MatchInputController({
      config: options.config,
      outbox: this.#outbox,
      matchStartedAtMs: startedAtMs,
      clientFrameBase: options.serverFrame,
      simulationHz: options.simulationHz,
      predict: options.predict,
      onUiAction: (action) => {
        if (action === "forfeit") options.onForfeit();
      }
    });
    this.#codes = configuredCodes(options.config);
    this.#keyDown = (event) => {
      if (!this.#codes.has(event.code)) return;
      event.preventDefault();
      this.#controller.keyDown({
        code: event.code,
        atMs: performance.now(),
        repeat: event.repeat
      });
    };
    this.#keyUp = (event) => {
      if (!this.#codes.has(event.code)) return;
      event.preventDefault();
      this.#controller.keyUp({
        code: event.code,
        atMs: performance.now()
      });
    };
    this.#blur = () => this.#controller.blur(performance.now());
    window.addEventListener("keydown", this.#keyDown);
    window.addEventListener("keyup", this.#keyUp);
    window.addEventListener("blur", this.#blur);
    this.#animationFrame = requestAnimationFrame(this.#advance);
  }

  get pending(): readonly MatchInputMessage[] {
    return this.#outbox.pending;
  }

  acknowledge(sequence: number): void {
    this.#outbox.acknowledge(sequence);
  }

  synchronizeServerFrame(serverFrame: number): void {
    this.#controller.synchronizeServerFrame(serverFrame, performance.now());
  }

  notifyPieceSpawned(cause: PieceSpawnCause): void {
    this.#controller.notifyPieceSpawned(performance.now(), cause);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    cancelAnimationFrame(this.#animationFrame);
    window.removeEventListener("keydown", this.#keyDown);
    window.removeEventListener("keyup", this.#keyUp);
    window.removeEventListener("blur", this.#blur);
  }

  #advance = (timestamp: number): void => {
    if (this.#disposed) return;
    this.#controller.advance(timestamp);
    this.#animationFrame = requestAnimationFrame(this.#advance);
  };
}
