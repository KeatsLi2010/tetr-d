import type {
  InputAction,
  MatchClientMessage
} from "../../../../packages/protocol/src/matchMessages.ts";

export type MatchInputMessage = Extract<
  MatchClientMessage,
  { readonly type: "match.input" }
>;

export interface InputOutboxOptions {
  readonly matchId: string;
  readonly inputEpoch: number;
  readonly nextSequence?: number;
  readonly send: (message: MatchInputMessage) => void;
}

const MAX_ACTIONS_PER_MESSAGE = 16;

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Sends immediately and retains messages for reconciliation. Enqueue never
 * waits for an ACK, so many sequences may remain in flight within one RTT.
 */
export class InputOutbox {
  readonly #matchId: string;
  readonly #inputEpoch: number;
  readonly #send: InputOutboxOptions["send"];
  readonly #pending = new Map<number, MatchInputMessage>();
  #nextSequence: number;

  constructor(options: InputOutboxOptions) {
    const nextSequence = options.nextSequence ?? 0;
    if (
      options.matchId.length === 0 ||
      !validCounter(options.inputEpoch) ||
      !validCounter(nextSequence)
    ) {
      throw new TypeError("Invalid input outbox options.");
    }
    this.#matchId = options.matchId;
    this.#inputEpoch = options.inputEpoch;
    this.#nextSequence = nextSequence;
    this.#send = options.send;
  }

  get nextSequence(): number {
    return this.#nextSequence;
  }

  get pending(): readonly MatchInputMessage[] {
    return Object.freeze([...this.#pending.values()]);
  }

  enqueue(
    clientFrame: number,
    actions: readonly InputAction[]
  ): readonly MatchInputMessage[] {
    if (!validCounter(clientFrame) || actions.length === 0) {
      throw new RangeError("Input batches require a frame and actions.");
    }
    const messages: MatchInputMessage[] = [];
    for (
      let offset = 0;
      offset < actions.length;
      offset += MAX_ACTIONS_PER_MESSAGE
    ) {
      const message: MatchInputMessage = Object.freeze({
        type: "match.input",
        matchId: this.#matchId,
        inputEpoch: this.#inputEpoch,
        sequence: this.#nextSequence,
        clientFrame,
        actions: Object.freeze(
          actions.slice(offset, offset + MAX_ACTIONS_PER_MESSAGE)
        )
      });
      this.#nextSequence += 1;
      this.#pending.set(message.sequence, message);
      this.#send(message);
      messages.push(message);
    }
    return Object.freeze(messages);
  }

  acknowledge(receivedThroughSequence: number): void {
    if (!validCounter(receivedThroughSequence)) return;
    for (const sequence of this.#pending.keys()) {
      if (sequence <= receivedThroughSequence) this.#pending.delete(sequence);
    }
  }
}
