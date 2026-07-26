import type { InputAction } from "../../../../packages/protocol/src/matchMessages.ts";

export type InputRejectionReason =
  | "unknown_player"
  | "wrong_epoch"
  | "gap"
  | "late"
  | "too_far_future"
  | "invalid";

export type QueuedInputDisposition =
  | {
      readonly status: "scheduled" | "applied";
      readonly sequence: number;
      readonly serverFrame: number;
    }
  | {
      readonly status: "rejected";
      readonly sequence: number;
      readonly reason: InputRejectionReason;
    };

export interface MatchInputEnvelope {
  readonly playerId: string;
  readonly inputEpoch: number;
  readonly sequence: number;
  readonly clientFrame: number;
  readonly actions: readonly InputAction[];
}

export interface ScheduledMatchInput extends MatchInputEnvelope {
  readonly serverFrame: number;
}

export interface MatchInputQueueOptions {
  readonly inputDelayFrames?: number;
  readonly maxClientFrameLag?: number;
  readonly maxClientFrameLead?: number;
  readonly historySize?: number;
}

interface PlayerInputState {
  epoch: number;
  nextSequence: number;
  readonly history: Map<number, QueuedInputDisposition>;
}

const DEFAULT_INPUT_DELAY_FRAMES = 1;
const DEFAULT_FRAME_WINDOW = 2_000;
const DEFAULT_HISTORY_SIZE = 128;

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export class MatchInputQueue {
  readonly #players = new Map<string, PlayerInputState>();
  readonly #playerOrder = new Map<string, number>();
  readonly #scheduled = new Map<number, ScheduledMatchInput[]>();
  readonly #inputDelayFrames: number;
  readonly #maxClientFrameLag: number;
  readonly #maxClientFrameLead: number;
  readonly #historySize: number;

  constructor(
    playerIds: readonly [string, string],
    options: MatchInputQueueOptions = {}
  ) {
    if (playerIds[0] === playerIds[1] || playerIds.some((id) => id.length === 0)) {
      throw new TypeError("Match input players must be distinct and non-empty.");
    }
    this.#inputDelayFrames =
      options.inputDelayFrames ?? DEFAULT_INPUT_DELAY_FRAMES;
    this.#maxClientFrameLag =
      options.maxClientFrameLag ?? DEFAULT_FRAME_WINDOW;
    this.#maxClientFrameLead =
      options.maxClientFrameLead ?? DEFAULT_FRAME_WINDOW;
    this.#historySize = options.historySize ?? DEFAULT_HISTORY_SIZE;
    for (const value of [
      this.#inputDelayFrames,
      this.#maxClientFrameLag,
      this.#maxClientFrameLead,
      this.#historySize
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("Invalid match input queue options.");
      }
    }
    if (this.#historySize < 1) {
      throw new TypeError("Input history must retain at least one entry.");
    }
    playerIds.forEach((playerId, index) => {
      this.#players.set(playerId, {
        epoch: 0,
        nextSequence: 0,
        history: new Map()
      });
      this.#playerOrder.set(playerId, index);
    });
  }

  enqueue(
    input: MatchInputEnvelope,
    currentServerFrame: number
  ): QueuedInputDisposition {
    if (!validCounter(currentServerFrame)) {
      throw new RangeError("Invalid current server frame.");
    }
    const player = this.#players.get(input.playerId);
    if (player === undefined) return this.#reject(input.sequence, "unknown_player");
    if (!this.#validEnvelope(input)) return this.#reject(input.sequence, "invalid");
    if (input.inputEpoch !== player.epoch) {
      return this.#reject(input.sequence, "wrong_epoch");
    }
    if (input.sequence < player.nextSequence) {
      return player.history.get(input.sequence) ?? this.#reject(input.sequence, "late");
    }
    if (input.sequence > player.nextSequence) {
      return this.#reject(input.sequence, "gap");
    }
    if (input.clientFrame < currentServerFrame - this.#maxClientFrameLag) {
      return this.#reject(input.sequence, "late");
    }
    if (input.clientFrame > currentServerFrame + this.#maxClientFrameLead) {
      return this.#reject(input.sequence, "too_far_future");
    }

    const serverFrame = currentServerFrame + this.#inputDelayFrames;
    if (!Number.isSafeInteger(serverFrame)) {
      return this.#reject(input.sequence, "invalid");
    }
    const scheduled: ScheduledMatchInput = Object.freeze({
      ...input,
      actions: Object.freeze([...input.actions]),
      serverFrame
    });
    const disposition: QueuedInputDisposition = Object.freeze({
      status: "scheduled",
      sequence: input.sequence,
      serverFrame
    });
    const frameInputs = this.#scheduled.get(serverFrame) ?? [];
    frameInputs.push(scheduled);
    this.#scheduled.set(serverFrame, frameInputs);
    player.nextSequence += 1;
    this.#remember(player, input.sequence, disposition);
    return disposition;
  }

  drain(serverFrame: number): readonly ScheduledMatchInput[] {
    if (!validCounter(serverFrame)) throw new RangeError("Invalid server frame.");
    const dueFrames = [...this.#scheduled.keys()]
      .filter((frame) => frame <= serverFrame)
      .sort((left, right) => left - right);
    const drained: ScheduledMatchInput[] = [];
    for (const frame of dueFrames) {
      const inputs = this.#scheduled.get(frame) ?? [];
      this.#scheduled.delete(frame);
      inputs.sort((left, right) =>
        (this.#playerOrder.get(left.playerId) ?? 0) -
          (this.#playerOrder.get(right.playerId) ?? 0) ||
        left.sequence - right.sequence
      );
      for (const input of inputs) {
        const state = this.#players.get(input.playerId);
        if (state === undefined || state.epoch !== input.inputEpoch) continue;
        this.#remember(state, input.sequence, Object.freeze({
          status: "applied",
          sequence: input.sequence,
          serverFrame: input.serverFrame
        }));
        drained.push(input);
      }
    }
    return Object.freeze(drained);
  }

  resetPlayer(playerId: string): { readonly inputEpoch: number; readonly nextSequence: 0 } {
    const player = this.#players.get(playerId);
    if (player === undefined) throw new RangeError("Player is not in this match.");
    player.epoch += 1;
    player.nextSequence = 0;
    player.history.clear();
    for (const [frame, inputs] of this.#scheduled) {
      const retained = inputs.filter((input) => input.playerId !== playerId);
      if (retained.length === 0) this.#scheduled.delete(frame);
      else this.#scheduled.set(frame, retained);
    }
    return Object.freeze({ inputEpoch: player.epoch, nextSequence: 0 });
  }

  viewPlayer(playerId: string): {
    readonly inputEpoch: number;
    readonly nextSequence: number;
  } {
    const player = this.#players.get(playerId);
    if (player === undefined) throw new RangeError("Player is not in this match.");
    return Object.freeze({
      inputEpoch: player.epoch,
      nextSequence: player.nextSequence
    });
  }

  #validEnvelope(input: MatchInputEnvelope): boolean {
    return (
      validCounter(input.inputEpoch) &&
      validCounter(input.sequence) &&
      validCounter(input.clientFrame) &&
      input.actions.length >= 1 &&
      input.actions.length <= 16
    );
  }

  #remember(
    state: PlayerInputState,
    sequence: number,
    disposition: QueuedInputDisposition
  ): void {
    state.history.delete(sequence);
    state.history.set(sequence, disposition);
    while (state.history.size > this.#historySize) {
      const oldest = state.history.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      state.history.delete(oldest);
    }
  }

  #reject(sequence: number, reason: InputRejectionReason): QueuedInputDisposition {
    return Object.freeze({ status: "rejected", sequence, reason });
  }
}
