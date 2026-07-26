import {
  createDefaultRoomCommitOutboxScheduler,
  prepareRoomOutboxCommit,
  RoomCommitDeliveryExhaustedError,
  RoomCommitOutboxCapacityError,
  RoomCommitOutboxConflictError,
  RoomCommitRetryScheduleFailedError,
  roomEffectDeliveryId
} from "./roomCommitOutboxModel.ts";
import type {
  PreparedRoomOutboxCommit,
  RoomCommitOutboxInput,
  RoomCommitOutboxOptions,
  RoomCommitOutboxScheduler,
  RoomEffectDelivery,
  RoomEffectDeliveryHandler,
  RoomOutboxCommit
} from "./roomCommitOutboxModel.ts";
import { RoomCommitOutboxWaitQueue } from "./roomCommitOutboxWaitQueue.ts";

export * from "./roomCommitOutboxModel.ts";

interface PendingCommit extends RoomOutboxCommit {
  readonly key: string;
  readonly fingerprint: string;
  nextEffectIndex: number;
  attempt: number;
}

interface RetryHandle { cancel(): void }

interface RoomLane {
  readonly commits: PendingCommit[];
  running: boolean;
  retryHandle: RetryHandle | null;
}

const DEFAULT_CAPACITY = 1_024;
const DEFAULT_WAITING_CAPACITY = 10_000;
const DEFAULT_COMPLETED_RETENTION = 4_096;
const DEFAULT_BASE_RETRY_MS = 100;
const DEFAULT_MAX_RETRY_MS = 30_000;

export class RoomCommitOutbox {
  readonly #handler: RoomEffectDeliveryHandler;
  readonly #scheduler: RoomCommitOutboxScheduler;
  readonly #recoveryScheduler: RoomCommitOutboxScheduler;
  readonly #clock: () => number;
  readonly #onError: NonNullable<RoomCommitOutboxOptions["onError"]>;
  readonly #capacity: number;
  readonly #waitingCapacity: number;
  readonly #completedRetention: number;
  readonly #baseRetryMs: number;
  readonly #maxRetryMs: number;
  readonly #maxAttempts: number;
  readonly #pendingByKey = new Map<string, PendingCommit>();
  readonly #waiting: RoomCommitOutboxWaitQueue;
  readonly #completed = new Map<string, string>();
  readonly #lanes = new Map<string, RoomLane>();
  #disposed = false;

  constructor(options: RoomCommitOutboxOptions) {
    this.#handler = options.handler;
    this.#clock = options.clock ?? Date.now;
    const fallback = createDefaultRoomCommitOutboxScheduler(this.#clock);
    this.#scheduler = options.scheduler ?? fallback;
    this.#recoveryScheduler = options.recoveryScheduler ?? fallback;
    this.#onError = options.onError ?? (() => undefined);
    this.#capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.#waitingCapacity = options.waitingCapacity ?? DEFAULT_WAITING_CAPACITY;
    this.#waiting = new RoomCommitOutboxWaitQueue(this.#waitingCapacity);
    this.#completedRetention =
      options.completedRetention ?? DEFAULT_COMPLETED_RETENTION;
    this.#baseRetryMs = options.baseRetryMs ?? DEFAULT_BASE_RETRY_MS;
    this.#maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    this.#maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
    if (
      typeof this.#handler !== "function" ||
      !Number.isSafeInteger(this.#capacity) ||
      this.#capacity <= 0 ||
      !Number.isSafeInteger(this.#waitingCapacity) ||
      this.#waitingCapacity <= 0 ||
      !Number.isSafeInteger(this.#completedRetention) ||
      this.#completedRetention <= 0 ||
      !Number.isSafeInteger(this.#baseRetryMs) ||
      this.#baseRetryMs < 0 ||
      !Number.isSafeInteger(this.#maxRetryMs) ||
      this.#maxRetryMs < this.#baseRetryMs ||
      (this.#maxAttempts !== Number.POSITIVE_INFINITY &&
        (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts <= 0))
    ) {
      throw new TypeError("Invalid room commit outbox options.");
    }
    this.#readNow();
  }

  get pendingCount(): number {
    return this.#pendingByKey.size;
  }

  get waitingCount(): number {
    return this.#waiting.count;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /**
   * Returns true for a new commit and false for an already-admitted duplicate.
   * A duplicate still waiting for capacity throws instead of reporting success.
   */
  enqueue(input: RoomCommitOutboxInput): boolean {
    this.#assertActive();
    const commit = prepareRoomOutboxCommit(input);
    if (this.#isKnownDuplicate(commit)) return false;
    this.#waiting.assertNotQueued(commit);
    if (
      this.#waiting.count > 0 ||
      this.#pendingByKey.size >= this.#capacity
    ) {
      throw new RoomCommitOutboxCapacityError();
    }
    this.#admit(commit);
    return true;
  }

  /**
   * Waits for bounded FIFO capacity. Duplicate waiters resolve false only
   * after the first waiter has actually been admitted.
   */
  enqueueDurably(input: RoomCommitOutboxInput): Promise<boolean> {
    try {
      this.#assertActive();
      const commit = prepareRoomOutboxCommit(input);
      if (this.#isKnownDuplicate(commit)) return Promise.resolve(false);
      const duplicate = this.#waiting.duplicateOf(commit);
      if (duplicate !== null) return duplicate;
      if (
        this.#waiting.count === 0 &&
        this.#pendingByKey.size < this.#capacity
      ) {
        this.#admit(commit);
        return Promise.resolve(true);
      }
      return this.#waiting.add(commit);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const lane of this.#lanes.values()) {
      if (lane.retryHandle === null) continue;
      try {
        lane.retryHandle.cancel();
      } catch (error) {
        this.#report(error, null);
      }
      lane.retryHandle = null;
    }
    this.#waiting.rejectAll(new Error("ROOM_COMMIT_OUTBOX_DISPOSED"));
    this.#lanes.clear();
    this.#pendingByKey.clear();
    this.#completed.clear();
  }

  #admit(commit: PreparedRoomOutboxCommit): void {
    const pending: PendingCommit = {
      ...commit,
      nextEffectIndex: 0,
      attempt: 1
    };
    this.#pendingByKey.set(commit.key, pending);
    let lane = this.#lanes.get(commit.roomId);
    if (lane === undefined) {
      lane = { commits: [], running: false, retryHandle: null };
      this.#lanes.set(commit.roomId, lane);
    }
    lane.commits.push(pending);
    queueMicrotask(() => this.#startLane(commit.roomId));
  }

  #admitWaiting(): void {
    while (
      !this.#disposed &&
      this.#pendingByKey.size < this.#capacity &&
      this.#waiting.count > 0
    ) {
      const waiting = this.#waiting.shift();
      if (waiting === undefined) return;
      try {
        if (this.#isKnownDuplicate(waiting.commit)) {
          waiting.resolve(false);
          continue;
        }
        this.#admit(waiting.commit);
        waiting.resolve(true);
      } catch (error) {
        waiting.reject(error);
      }
    }
  }

  #isKnownDuplicate(commit: PreparedRoomOutboxCommit): boolean {
    const pending = this.#pendingByKey.get(commit.key);
    if (pending !== undefined) {
      this.#assertSameFingerprint(pending.fingerprint, commit);
      return true;
    }
    const completedFingerprint = this.#completed.get(commit.key);
    if (completedFingerprint === undefined) return false;
    this.#assertSameFingerprint(completedFingerprint, commit);
    this.#touchCompleted(commit.key, completedFingerprint);
    return true;
  }

  #assertSameFingerprint(
    fingerprint: string,
    commit: PreparedRoomOutboxCommit
  ): void {
    if (fingerprint !== commit.fingerprint) {
      throw new RoomCommitOutboxConflictError();
    }
  }

  #startLane(roomId: string): void {
    const lane = this.#lanes.get(roomId);
    if (
      this.#disposed ||
      lane === undefined ||
      lane.running ||
      lane.retryHandle !== null
    ) {
      return;
    }
    void this.#pump(roomId, lane).catch((error) => {
      this.#report(error, null);
    });
  }

  async #pump(roomId: string, lane: RoomLane): Promise<void> {
    lane.running = true;
    try {
      while (!this.#disposed && lane.commits.length > 0) {
        const commit = lane.commits[0];
        if (commit === undefined) break;
        if (commit.nextEffectIndex >= commit.effects.length) {
          this.#complete(lane, commit);
          continue;
        }

        const effectIndex = commit.nextEffectIndex;
        const effect = commit.effects[effectIndex];
        if (effect === undefined) throw new Error("Missing outbox effect.");
        const delivery: RoomEffectDelivery = Object.freeze({
          deliveryId: roomEffectDeliveryId(
            commit.roomId,
            commit.revision,
            effectIndex
          ),
          roomId: commit.roomId,
          revision: commit.revision,
          effectIndex,
          attempt: commit.attempt,
          effect
        });
        try {
          await this.#handler(delivery);
        } catch (error) {
          this.#report(error, delivery);
          if (this.#disposed) return;
          if (commit.attempt >= this.#maxAttempts) {
            this.#report(
              new RoomCommitDeliveryExhaustedError(delivery.deliveryId),
              delivery
            );
            commit.nextEffectIndex += 1;
            commit.attempt = 1;
            continue;
          }
          const delayMs = Math.min(
            this.#maxRetryMs,
            this.#baseRetryMs *
              2 ** Math.min(commit.attempt - 1, 52)
          );
          commit.attempt += 1;
          this.#scheduleRetry(roomId, lane, delayMs, delivery);
          return;
        }
        if (this.#disposed) return;
        commit.nextEffectIndex += 1;
        commit.attempt = 1;
      }
    } finally {
      lane.running = false;
      if (!this.#disposed && lane.commits.length === 0) {
        this.#lanes.delete(roomId);
      }
    }
  }

  #scheduleRetry(
    roomId: string,
    lane: RoomLane,
    delayMs: number,
    delivery: RoomEffectDelivery
  ): void {
    const deadlineMs = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.#readNow() + delayMs
    );
    if (this.#trySchedule(this.#scheduler, roomId, lane, deadlineMs, delivery)) {
      return;
    }
    if (
      this.#trySchedule(
        this.#recoveryScheduler,
        roomId,
        lane,
        deadlineMs,
        delivery
      )
    ) {
      return;
    }
    // Both schedulers failed: report and preserve the current pending effect.
    this.#report(
      new RoomCommitRetryScheduleFailedError(delivery.deliveryId),
      delivery
    );
  }

  #trySchedule(
    scheduler: RoomCommitOutboxScheduler,
    roomId: string,
    lane: RoomLane,
    deadlineMs: number,
    delivery: RoomEffectDelivery
  ): boolean {
    let fired = false;
    try {
      const handle = scheduler.schedule(deadlineMs, () => {
        fired = true;
        lane.retryHandle = null;
        queueMicrotask(() => this.#startLane(roomId));
      });
      if (!fired) {
        lane.retryHandle = { cancel: () => scheduler.cancel(handle) };
      }
      return true;
    } catch (error) {
      this.#report(error, delivery);
      return false;
    }
  }

  #complete(lane: RoomLane, commit: PendingCommit): void {
    lane.commits.shift();
    this.#pendingByKey.delete(commit.key);
    this.#completed.set(commit.key, commit.fingerprint);
    while (this.#completed.size > this.#completedRetention) {
      const oldest = this.#completed.keys().next().value;
      if (oldest === undefined) break;
      this.#completed.delete(oldest);
    }
    this.#admitWaiting();
  }

  #touchCompleted(key: string, fingerprint: string): void {
    this.#completed.delete(key);
    this.#completed.set(key, fingerprint);
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("ROOM_COMMIT_OUTBOX_DISPOSED");
  }

  #readNow(): number {
    const nowMs = this.#clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new RangeError("Room commit outbox clock returned an invalid time.");
    }
    return nowMs;
  }

  #report(error: unknown, delivery: RoomEffectDelivery | null): void {
    try {
      this.#onError(error, delivery);
    } catch {
      // Error reporting is a terminal boundary and must never break delivery.
    }
  }
}
