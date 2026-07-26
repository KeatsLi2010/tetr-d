export const DEFAULT_MAX_PENDING_MESSAGES = 64;

export interface GatewayMessageQueueOptions {
  readonly capacity: number | undefined;
  readonly onError: (error: unknown) => void;
}

/**
 * A bounded serial lane. Capacity counts the running item and queued items.
 */
export class GatewayMessageQueue {
  readonly #capacity: number;
  readonly #onError: (error: unknown) => void;
  #tail: Promise<void> = Promise.resolve();
  #pendingCount = 0;

  constructor(options: GatewayMessageQueueOptions) {
    this.#capacity = options.capacity ?? DEFAULT_MAX_PENDING_MESSAGES;
    this.#onError = options.onError;
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity <= 0) {
      throw new TypeError("Invalid message queue capacity.");
    }
  }

  get pendingCount(): number {
    return this.#pendingCount;
  }

  enqueue(work: () => void | Promise<void>): boolean {
    if (this.#pendingCount >= this.#capacity) return false;
    this.#pendingCount += 1;
    const pending = this.#tail.then(work);
    this.#tail = pending.then(
      () => {
        this.#pendingCount -= 1;
      },
      (error) => {
        this.#pendingCount -= 1;
        try {
          this.#onError(error);
        } catch {
          // Error reporting is terminal and must not poison the serial tail.
        }
      }
    );
    return true;
  }
}
