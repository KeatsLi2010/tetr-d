import {
  RoomCommitOutboxCapacityError,
  RoomCommitOutboxConflictError,
  RoomCommitOutboxWaitCapacityError
} from "./roomCommitOutboxModel.ts";
import type {
  PreparedRoomOutboxCommit
} from "./roomCommitOutboxModel.ts";

export interface RoomCommitWaitAdmission {
  readonly commit: PreparedRoomOutboxCommit;
  readonly resolve: (accepted: boolean) => void;
  readonly reject: (error: unknown) => void;
}

interface WaitingCommit extends RoomCommitWaitAdmission {
  readonly admitted: Promise<boolean>;
  duplicate: Promise<boolean> | null;
}

export class RoomCommitOutboxWaitQueue {
  readonly #capacity: number;
  readonly #waitingByKey = new Map<string, WaitingCommit>();

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  get count(): number {
    return this.#waitingByKey.size;
  }

  duplicateOf(
    commit: PreparedRoomOutboxCommit
  ): Promise<boolean> | null {
    const waiting = this.#waitingByKey.get(commit.key);
    if (waiting === undefined) return null;
    this.#assertSameFingerprint(waiting.commit, commit);
    if (waiting.duplicate === null) {
      waiting.duplicate = waiting.admitted.then(() => false);
      /*
       * Mark the one shared derived promise handled internally. Returning the
       * original promise still propagates rejection to every real caller.
       */
      void waiting.duplicate.catch(() => undefined);
    }
    return waiting.duplicate;
  }

  assertNotQueued(commit: PreparedRoomOutboxCommit): void {
    const waiting = this.#waitingByKey.get(commit.key);
    if (waiting === undefined) return;
    this.#assertSameFingerprint(waiting.commit, commit);
    /*
     * The synchronous API cannot truthfully return duplicate=false before
     * admission, so callers must retry or use enqueueDurably().
     */
    throw new RoomCommitOutboxCapacityError();
  }

  add(commit: PreparedRoomOutboxCommit): Promise<boolean> {
    if (this.#waitingByKey.size >= this.#capacity) {
      throw new RoomCommitOutboxWaitCapacityError();
    }
    let resolve!: (accepted: boolean) => void;
    let reject!: (error: unknown) => void;
    const admitted = new Promise<boolean>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    this.#waitingByKey.set(commit.key, {
      commit,
      admitted,
      duplicate: null,
      resolve,
      reject
    });
    return admitted;
  }

  shift(): RoomCommitWaitAdmission | undefined {
    const entry = this.#waitingByKey.entries().next().value;
    if (entry === undefined) return undefined;
    this.#waitingByKey.delete(entry[0]);
    return entry[1];
  }

  rejectAll(error: unknown): void {
    for (const waiting of this.#waitingByKey.values()) {
      waiting.reject(error);
    }
    this.#waitingByKey.clear();
  }

  #assertSameFingerprint(
    waiting: PreparedRoomOutboxCommit,
    incoming: PreparedRoomOutboxCommit
  ): void {
    if (waiting.fingerprint !== incoming.fingerprint) {
      throw new RoomCommitOutboxConflictError();
    }
  }
}
