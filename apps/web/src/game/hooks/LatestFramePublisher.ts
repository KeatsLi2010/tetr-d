export interface AnimationFrameScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

/**
 * Keeps only the newest realtime value until the browser can paint again.
 * Urgent local values bypass the queue and cancel any stale scheduled publish.
 */
export class LatestFramePublisher<T> {
  readonly #publish: (value: T) => void;
  readonly #scheduler: AnimationFrameScheduler;
  #scheduledHandle: number | null = null;
  #latest: T | null = null;
  #disposed = false;

  constructor(
    publish: (value: T) => void,
    scheduler: AnimationFrameScheduler
  ) {
    this.#publish = publish;
    this.#scheduler = scheduler;
  }

  enqueue(value: T): void {
    if (this.#disposed) return;
    this.#latest = value;
    if (this.#scheduledHandle !== null) return;
    this.#scheduledHandle = this.#scheduler.request(this.#flush);
  }

  publishNow(value: T): void {
    if (this.#disposed) return;
    this.#cancelScheduled();
    this.#latest = null;
    this.#publish(value);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelScheduled();
    this.#latest = null;
  }

  readonly #flush = (): void => {
    this.#scheduledHandle = null;
    const latest = this.#latest;
    this.#latest = null;
    if (!this.#disposed && latest !== null) this.#publish(latest);
  };

  #cancelScheduled(): void {
    if (this.#scheduledHandle === null) return;
    this.#scheduler.cancel(this.#scheduledHandle);
    this.#scheduledHandle = null;
  }
}

export const BROWSER_FRAME_SCHEDULER: AnimationFrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle)
};
