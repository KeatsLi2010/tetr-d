export type RoomTaskCallback = () => void | Promise<void>;

export interface RoomScheduler {
  schedule(key: string, deadlineMs: number, callback: RoomTaskCallback): void;
  cancel(key: string): void;
  cancelAll(): void;
}

interface ScheduledTask {
  readonly deadlineMs: number;
  readonly handle: NodeJS.Timeout;
}

export interface TimeoutRoomSchedulerOptions {
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export class TimeoutRoomScheduler implements RoomScheduler {
  readonly #tasks = new Map<string, ScheduledTask>();
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;

  constructor(options: TimeoutRoomSchedulerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => undefined);
  }

  schedule(
    key: string,
    deadlineMs: number,
    callback: RoomTaskCallback
  ): void {
    const existing = this.#tasks.get(key);
    if (existing?.deadlineMs === deadlineMs) return;
    if (existing !== undefined) clearTimeout(existing.handle);
    const delay = Math.max(0, deadlineMs - this.#now());
    const handle = setTimeout(() => {
      const current = this.#tasks.get(key);
      if (current?.handle !== handle) return;
      this.#tasks.delete(key);
      try {
        Promise.resolve(callback()).catch((error) => {
          this.#reportError(error);
        });
      } catch (error) {
        this.#reportError(error);
      }
    }, delay);
    handle.unref();
    this.#tasks.set(key, { deadlineMs, handle });
  }

  cancel(key: string): void {
    const task = this.#tasks.get(key);
    if (task === undefined) return;
    clearTimeout(task.handle);
    this.#tasks.delete(key);
  }

  cancelAll(): void {
    for (const task of this.#tasks.values()) clearTimeout(task.handle);
    this.#tasks.clear();
  }

  #reportError(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Error reporting is the final boundary and must never crash the timer loop.
    }
  }
}
