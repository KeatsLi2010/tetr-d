import type {
  BufferMode,
  PlayerActionName,
  PlayerConfig
} from "../config/v3/index.ts";
import type { PieceSpawnCause } from "./handlingEngine.ts";
import {
  HOLD,
  rotateAction,
  type ExpandedPlayerAction,
  type RotationDirection
} from "./playerActions.ts";

const ROTATION_ACTIONS = {
  rotateCW: "cw",
  rotateCCW: "ccw",
  rotate180: "180"
} as const satisfies Partial<Record<PlayerActionName, RotationDirection>>;

type BufferedActionName = keyof typeof ROTATION_ACTIONS | "hold";
type PreparedCause = Extract<PieceSpawnCause, "hardDrop" | "hold">;

interface RotationPress {
  readonly code: string;
  readonly direction: RotationDirection;
}

function relevant(action: PlayerActionName): action is BufferedActionName {
  return action === "hold" || action in ROTATION_ACTIONS;
}

export class GenerationInputBuffer {
  readonly #irs: BufferMode;
  readonly #ihs: BufferMode;
  readonly #bindings = new Map<string, BufferedActionName[]>();
  readonly #pressedCodes = new Set<string>();
  readonly #heldCounts = new Map<BufferedActionName, number>();
  readonly #rotationOrder: RotationPress[] = [];
  readonly #prepared: PreparedCause[] = [];
  #tapHold = false;
  #tapRotation: RotationDirection | null = null;

  constructor(config: PlayerConfig) {
    this.#irs = config.handling.irs;
    this.#ihs = config.handling.ihs;
    for (const [action, codes] of Object.entries(config.bindings)) {
      if (!relevant(action as PlayerActionName)) continue;
      for (const code of codes) {
        const owners = this.#bindings.get(code) ?? [];
        owners.push(action as BufferedActionName);
        this.#bindings.set(code, owners);
      }
    }
  }

  keyDown(code: string, repeat = false): void {
    if (repeat || this.#pressedCodes.has(code)) return;
    this.#pressedCodes.add(code);
    for (const action of this.#bindings.get(code) ?? []) {
      const count = this.#heldCounts.get(action) ?? 0;
      this.#heldCounts.set(action, count + 1);
      if (action === "hold") {
        this.#tapHold = true;
      } else {
        const direction = ROTATION_ACTIONS[action];
        // Keep one entry per physical key so releasing an alternate binding
        // cannot remove a different, still-held rotation.
        this.#rotationOrder.push({ code, direction });
        this.#tapRotation = direction;
      }
    }
  }

  keyUp(code: string): void {
    if (!this.#pressedCodes.delete(code)) return;
    for (const action of this.#bindings.get(code) ?? []) {
      if (action !== "hold") {
        this.#removeRotationPress(code, ROTATION_ACTIONS[action]);
      }
      const count = this.#heldCounts.get(action) ?? 0;
      if (count > 1) {
        this.#heldCounts.set(action, count - 1);
        continue;
      }
      this.#heldCounts.delete(action);
    }
  }

  expand(
    actions: readonly ExpandedPlayerAction[]
  ): readonly ExpandedPlayerAction[] {
    const output: ExpandedPlayerAction[] = [];
    let generationPending = false;
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index]!;
      output.push(action);
      if (
        !generationPending &&
        (action.kind === "hardDrop" || action.kind === "hold")
      ) {
        generationPending = true;
        const cause = action.kind;
        output.push(...this.#consume(cause, actions.slice(index + 1)));
        this.#prepared.push(cause);
      } else if (!generationPending && action.kind === "rotate") {
        if (this.#tapRotation === action.direction) {
          this.#tapRotation = null;
        }
      }
    }
    return Object.freeze(output);
  }

  spawned(cause: PieceSpawnCause): readonly ExpandedPlayerAction[] {
    const preparedIndex = this.#prepared.indexOf(cause as PreparedCause);
    if (preparedIndex >= 0) {
      this.#prepared.splice(0, preparedIndex + 1);
      return Object.freeze([]);
    }
    this.#prepared.length = 0;
    return this.#consume(cause);
  }

  clear(): void {
    this.#pressedCodes.clear();
    this.#heldCounts.clear();
    this.#rotationOrder.length = 0;
    this.#prepared.length = 0;
    this.#tapHold = false;
    this.#tapRotation = null;
  }

  #removeRotationPress(
    code: string,
    direction: RotationDirection
  ): void {
    for (let index = this.#rotationOrder.length - 1; index >= 0; index -= 1) {
      const press = this.#rotationOrder[index];
      if (press?.code === code && press.direction === direction) {
        this.#rotationOrder.splice(index, 1);
        return;
      }
    }
  }

  #consume(
    cause: PieceSpawnCause,
    existing: readonly ExpandedPlayerAction[] = []
  ): readonly ExpandedPlayerAction[] {
    const output: ExpandedPlayerAction[] = [];
    const bufferedHold = this.#ihs === "hold"
      ? this.#heldCounts.has("hold")
      : this.#ihs === "tap" && this.#tapHold;
    const rotation = this.#irs === "hold"
      ? this.#rotationOrder.at(-1)?.direction ?? null
      : this.#irs === "tap" ? this.#tapRotation : null;
    if (
      cause !== "hold" &&
      bufferedHold &&
      !existing.some((action) => action.kind === "hold")
    ) output.push(HOLD);
    if (
      rotation !== null &&
      !existing.some((action) => action.kind === "rotate")
    ) output.push(rotateAction(rotation));
    this.#tapHold = false;
    this.#tapRotation = null;
    return Object.freeze(output);
  }
}
