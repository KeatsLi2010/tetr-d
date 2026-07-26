import { randomUUID } from "node:crypto";

import type {
  RoomState
} from "../../../../packages/room-core/src/model.ts";
import {
  RoomActor
} from "../roomActor.ts";
import type {
  RoomActorPrincipal,
  RoomDispatchResult,
  RoomSystemCommand,
  RoomUserCommand
} from "../roomActor.ts";
import {
  TimeoutRoomScheduler
} from "./roomScheduler.ts";
import type { RoomScheduler } from "./roomScheduler.ts";
import { RoomRuntimeDisposeGate } from "./roomRuntimeDisposeGate.ts";
import {
  DEFAULT_DISPATCH_QUEUE_CAPACITY,
  RoomRuntimeQueueCapacityError
} from "./roomRuntimeModel.ts";
import type {
  RoomRuntimeCommit,
  RoomRuntimeOptions
} from "./roomRuntimeModel.ts";

export { RoomRuntimeQueueCapacityError };
export type { RoomRuntimeCommit, RoomRuntimeOptions };

export class RoomRuntime {
  readonly #actor: RoomActor;
  readonly #scheduler: RoomScheduler;
  readonly #matchIdFactory: () => string;
  readonly #onCommit: (
    commit: RoomRuntimeCommit
  ) => void | Promise<void>;
  readonly #onError: (error: unknown) => void;
  readonly #now: () => number;
  readonly #timerRetryDelayMs: number;
  readonly #commitRetryBaseMs: number;
  readonly #commitRetryMaxMs: number;
  readonly #taskPrefix: string;
  readonly #ownedTaskKeys = new Set<string>();
  readonly #timerRetryAtMs = new Map<string, number>();
  readonly #reconnectTaskKeys = new Set<string>();
  readonly #disposeGate = new RoomRuntimeDisposeGate();
  readonly #dispatchQueueCapacity: number;
  #commitRetryResolve: (() => void) | null = null;
  #unpublishedCommit: RoomRuntimeCommit | null = null;
  #tail: Promise<void> = Promise.resolve();
  #pendingDispatches = 0;
  #disposed = false;
  #generation = 0;

  constructor(actor: RoomActor, options: RoomRuntimeOptions = {}) {
    this.#actor = actor;
    this.#onError = options.onError ?? (() => undefined);
    this.#scheduler =
      options.scheduler ??
      new TimeoutRoomScheduler({ onError: this.#onError });
    this.#matchIdFactory =
      options.matchIdFactory ?? (() => `m_${randomUUID()}`);
    this.#onCommit = options.onCommit ?? (() => undefined);
    this.#now = options.now ?? Date.now;
    this.#timerRetryDelayMs = options.timerRetryDelayMs ?? 250;
    this.#commitRetryBaseMs = options.commitRetryBaseMs ?? 100;
    this.#commitRetryMaxMs = options.commitRetryMaxMs ?? 30_000;
    this.#dispatchQueueCapacity =
      options.dispatchQueueCapacity ?? DEFAULT_DISPATCH_QUEUE_CAPACITY;
    this.#taskPrefix = `room:${actor.snapshot.roomId}:`;
    if (
      !Number.isSafeInteger(this.#timerRetryDelayMs) ||
      this.#timerRetryDelayMs <= 0 ||
      !Number.isSafeInteger(this.#commitRetryBaseMs) ||
      this.#commitRetryBaseMs <= 0 ||
      !Number.isSafeInteger(this.#commitRetryMaxMs) ||
      this.#commitRetryMaxMs < this.#commitRetryBaseMs ||
      !Number.isSafeInteger(this.#dispatchQueueCapacity) ||
      this.#dispatchQueueCapacity <= 0
    ) {
      throw new TypeError("Invalid room runtime retry options.");
    }
    this.#safeReconcile(actor.snapshot);
  }

  get snapshot(): RoomState {
    return this.#actor.snapshot;
  }

  dispatchUser(
    principal: RoomActorPrincipal,
    command: RoomUserCommand
  ): Promise<RoomDispatchResult> {
    return this.#enqueue(async (generation) => {
      const before = this.#actor.snapshot;
      const result = await this.#actor.dispatchUser(principal, command);
      this.#assertActive(generation);
      await this.#afterDispatch(before, result, generation);
      this.#assertActive(generation);
      return result;
    });
  }

  dispatchSystem(command: RoomSystemCommand): Promise<RoomDispatchResult> {
    return this.#enqueue(async (generation) => {
      const before = this.#actor.snapshot;
      const result = await this.#actor.dispatchSystem(command);
      this.#assertActive(generation);
      await this.#afterDispatch(before, result, generation);
      this.#assertActive(generation);
      return result;
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#disposeGate.dispose();
    this.#cancelOwnedTasks();
    this.#commitRetryResolve?.();
    this.#commitRetryResolve = null;
    this.#unpublishedCommit = null;
    this.#timerRetryAtMs.clear();
    this.#reconnectTaskKeys.clear();
  }

  #enqueue<T>(work: (generation: number) => Promise<T>): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new Error("Room runtime is disposed."));
    }
    if (this.#pendingDispatches >= this.#dispatchQueueCapacity) {
      return Promise.reject(new RoomRuntimeQueueCapacityError());
    }
    this.#pendingDispatches += 1;
    const generation = this.#generation;
    const result = this.#tail.then(() => {
      this.#assertActive(generation);
      return work(generation);
    });
    this.#tail = result.then(
      () => {
        this.#pendingDispatches -= 1;
      },
      () => {
        this.#pendingDispatches -= 1;
      }
    );
    return result;
  }

  async #afterDispatch(
    before: RoomState,
    result: RoomDispatchResult,
    generation: number
  ): Promise<void> {
    this.#safeReconcile(result.state);
    if (result.replayed || result.receipt.kind !== "committed") return;
    const commit: RoomRuntimeCommit = {
      before,
      after: result.state,
      effects: result.effects
    };
    await this.#publishCommit(commit, generation);
  }

  async #publishCommit(
    commit: RoomRuntimeCommit,
    generation: number
  ): Promise<void> {
    if (
      this.#unpublishedCommit !== null &&
      this.#unpublishedCommit !== commit
    ) {
      throw new Error("Room runtime already has an unpublished commit.");
    }
    this.#unpublishedCommit = commit;
    let failedAttempts = 0;
    while (true) {
      this.#assertActive(generation);
      try {
        await this.#disposeGate.run(() => this.#onCommit(commit));
        this.#assertActive(generation);
        this.#unpublishedCommit = null;
        return;
      } catch (error) {
        if (this.#disposed || generation !== this.#generation) throw error;
        this.#reportError(error);
      }
      failedAttempts += 1;
      await this.#waitForCommitRetry(failedAttempts, generation);
    }
  }

  #waitForCommitRetry(
    failedAttempts: number,
    generation: number
  ): Promise<void> {
    const delayMs = Math.min(
      this.#commitRetryMaxMs,
      this.#commitRetryBaseMs *
        2 ** Math.min(failedAttempts - 1, 52)
    );
    const deadlineMs = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.#readNow() + delayMs
    );
    const ownedKey = `${this.#taskPrefix}commit-publish`;
    const wait = new Promise<void>((resolve) => {
      let settled = false;
      const resume = () => {
        if (settled) return;
        settled = true;
        if (this.#commitRetryResolve === resume) {
          this.#commitRetryResolve = null;
        }
        this.#ownedTaskKeys.delete(ownedKey);
        resolve();
      };
      this.#commitRetryResolve = resume;
      this.#ownedTaskKeys.add(ownedKey);
      try {
        this.#scheduler.schedule(ownedKey, deadlineMs, resume);
      } catch (error) {
        this.#ownedTaskKeys.delete(ownedKey);
        this.#reportError(error);
        // Keep the dispatch fail-stopped until disposal; do not lose commit.
      }
    });
    return wait.then(() => this.#assertActive(generation));
  }

  #reconcile(state: RoomState): void {
    if (state.phase === "closed") {
      this.#cancelOwnedTasks();
      this.#timerRetryAtMs.clear();
      this.#reconnectTaskKeys.clear();
      return;
    }

    this.#schedule(
      "room-expiry",
      state.expiresAtMs,
      () => this.#runTimer("room-expiry", () => ({
        type: "timer.room_expired"
      }))
    );

    if (state.countdown === null) {
      this.#cancel("countdown");
      this.#timerRetryAtMs.delete("countdown");
    } else {
      const { countdownId, startsAtMs } = state.countdown;
      this.#schedule("countdown", startsAtMs, () =>
        this.#runTimer("countdown", () => ({
          type: "timer.countdown_elapsed",
          countdownId,
          matchId: this.#matchIdFactory()
        }))
      );
    }

    const desiredReconnectKeys = new Set<string>();
    for (const [playerId, member] of Object.entries(state.members)) {
      if (member.connection.kind !== "disconnected") continue;
      const key = `reconnect:${playerId}`;
      desiredReconnectKeys.add(key);
      const expectedConnectionEpoch = member.connection.epoch;
      this.#schedule(
        key,
        member.connection.reconnectDeadlineMs,
        () =>
          this.#runTimer(key, () => ({
            type: "timer.reconnect_elapsed",
            playerId,
            expectedConnectionEpoch
          }))
      );
    }
    for (const key of this.#reconnectTaskKeys) {
      if (desiredReconnectKeys.has(key)) continue;
      this.#cancel(key);
      this.#timerRetryAtMs.delete(key);
    }
    this.#reconnectTaskKeys.clear();
    for (const key of desiredReconnectKeys) this.#reconnectTaskKeys.add(key);
  }

  async #runTimer(
    key: string,
    createCommand: () => RoomSystemCommand
  ): Promise<void> {
    try {
      const result = await this.dispatchSystem(createCommand());
      if (result.receipt.kind === "committed") {
        this.#timerRetryAtMs.delete(key);
        return;
      }
      this.#delayTimer(key);
    } catch (error) {
      if (this.#disposed) return;
      if (!(error instanceof RoomRuntimeQueueCapacityError)) {
        this.#reportError(error);
      }
      this.#delayTimer(key);
    }
  }

  #delayTimer(key: string): void {
    this.#timerRetryAtMs.set(key, this.#readNow() + this.#timerRetryDelayMs);
    this.#safeReconcile(this.#actor.snapshot);
  }

  #safeReconcile(state: RoomState): void {
    if (this.#disposed) return;
    try {
      this.#reconcile(state);
    } catch (error) {
      this.#reportError(error);
    }
  }

  #schedule(
    key: string,
    deadlineMs: number,
    callback: () => void | Promise<void>
  ): void {
    const ownedKey = `${this.#taskPrefix}${key}`;
    const retryAtMs = this.#timerRetryAtMs.get(key) ?? 0;
    this.#scheduler.schedule(
      ownedKey,
      Math.max(deadlineMs, retryAtMs),
      callback
    );
    this.#ownedTaskKeys.add(ownedKey);
  }

  #cancel(key: string): void {
    const ownedKey = `${this.#taskPrefix}${key}`;
    this.#ownedTaskKeys.delete(ownedKey);
    try {
      this.#scheduler.cancel(ownedKey);
    } catch (error) {
      this.#reportError(error);
    }
  }

  #cancelOwnedTasks(): void {
    const keys = [...this.#ownedTaskKeys];
    this.#ownedTaskKeys.clear();
    for (const key of keys) {
      try {
        this.#scheduler.cancel(key);
      } catch (error) {
        this.#reportError(error);
      }
    }
  }

  #assertActive(generation: number): void {
    if (this.#disposed || generation !== this.#generation) {
      throw new Error("Room runtime is disposed.");
    }
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      this.#reportError(new RangeError("Room runtime clock is invalid."));
      return 0;
    }
    return value;
  }

  #reportError(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Error reporting is the final boundary and must never reject dispatch.
    }
  }
}
