import assert from "node:assert/strict";
import test from "node:test";

import type { RoomEffect } from "../../../packages/room-core/src/model.ts";
import {
  RoomCommitDeliveryExhaustedError,
  RoomCommitOutbox,
  RoomCommitOutboxCapacityError,
  RoomCommitOutboxConflictError
} from "../src/rooms/roomCommitOutbox.ts";
import type {
  RoomCommitOutboxScheduler,
  RoomEffectDelivery
} from "../src/rooms/roomCommitOutbox.ts";

const STATE_EFFECT: RoomEffect = {
  type: "room.state_changed",
  revision: 2,
  presenceSequence: 2
};
const CLOSE_EFFECT: RoomEffect = {
  type: "room.closed",
  reason: "expired"
};

class ManualScheduler implements RoomCommitOutboxScheduler {
  readonly tasks = new Map<
    number,
    { readonly deadlineMs: number; readonly callback: () => void }
  >();
  #nextId = 1;

  schedule(deadlineMs: number, callback: () => void): number {
    const id = this.#nextId++;
    this.tasks.set(id, { deadlineMs, callback });
    return id;
  }

  cancel(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  runNext(setNow: (value: number) => void): number {
    const next = [...this.tasks.entries()].sort(
      (left, right) => left[1].deadlineMs - right[1].deadlineMs
    )[0];
    if (next === undefined) throw new Error("No scheduled retry.");
    this.tasks.delete(next[0]);
    setNow(next[1].deadlineMs);
    next[1].callback();
    return next[1].deadlineMs;
  }
}

function commit(
  roomId: string,
  revision: number,
  effects: readonly RoomEffect[] = [STATE_EFFECT]
) {
  return { roomId, revision, effects } as const;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(
  predicate: () => boolean,
  attempts = 20
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("Condition was not reached.");
}

test("enqueue is non-blocking and effects stay ordered per room", async () => {
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const delivered: string[] = [];
  const outbox = new RoomCommitOutbox({
    handler: async (delivery) => {
      delivered.push(delivery.deliveryId);
      if (delivered.length === 1) await firstBlocked;
    }
  });

  assert.equal(
    outbox.enqueue(commit("room-a", 2, [STATE_EFFECT, CLOSE_EFFECT])),
    true
  );
  assert.equal(outbox.enqueue(commit("room-a", 3)), true);
  assert.deepEqual(delivered, []);
  await flush();
  assert.equal(delivered.length, 1);

  releaseFirst();
  await waitUntil(() => outbox.pendingCount === 0);
  assert.equal(delivered.length, 3);
  const [first, second, third] = delivered;
  assert.ok(first && second && third);
  assert.match(first, /:2:0$/);
  assert.match(second, /:2:1$/);
  assert.match(third, /:3:0$/);
});

test("different room lanes can progress independently", async () => {
  let releaseA!: () => void;
  const blockedA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const delivered: string[] = [];
  const outbox = new RoomCommitOutbox({
    handler: async (delivery) => {
      delivered.push(delivery.roomId);
      if (delivery.roomId === "room-a") await blockedA;
    }
  });

  outbox.enqueue(commit("room-a", 2));
  outbox.enqueue(commit("room-b", 2));
  await waitUntil(() => delivered.includes("room-b"));
  assert.deepEqual(delivered, ["room-a", "room-b"]);
  assert.equal(outbox.pendingCount, 1);

  releaseA();
  await waitUntil(() => outbox.pendingCount === 0);
});

test("room and revision deduplicate pending and completed commits", async () => {
  let deliveries = 0;
  const outbox = new RoomCommitOutbox({
    handler: () => {
      deliveries += 1;
    }
  });
  const value = commit("room-a", 2);

  assert.equal(outbox.enqueue(value), true);
  assert.equal(outbox.enqueue(value), false);
  await waitUntil(() => outbox.pendingCount === 0);
  assert.equal(outbox.enqueue(value), false);
  await flush();
  assert.equal(deliveries, 1);

  assert.throws(
    () => outbox.enqueue(commit("room-a", 2, [CLOSE_EFFECT])),
    RoomCommitOutboxConflictError
  );
});

test("retry uses exponential backoff and a stable delivery id", async () => {
  let nowMs = 1_000;
  const scheduler = new ManualScheduler();
  const attempts: RoomEffectDelivery[] = [];
  const errors: unknown[] = [];
  const outbox = new RoomCommitOutbox({
    clock: () => nowMs,
    scheduler,
    baseRetryMs: 100,
    maxRetryMs: 1_000,
    handler: (delivery) => {
      attempts.push(delivery);
      if (delivery.attempt < 3) throw new Error("temporary");
    },
    onError: (error) => errors.push(error)
  });

  outbox.enqueue(commit("room-a", 2));
  await waitUntil(() => scheduler.tasks.size === 1);
  assert.equal(
    scheduler.runNext((value) => {
      nowMs = value;
    }),
    1_100
  );
  await waitUntil(() => scheduler.tasks.size === 1);
  assert.equal(
    scheduler.runNext((value) => {
      nowMs = value;
    }),
    1_300
  );
  await waitUntil(() => outbox.pendingCount === 0);

  assert.deepEqual(attempts.map((value) => value.attempt), [1, 2, 3]);
  assert.equal(new Set(attempts.map((value) => value.deliveryId)).size, 1);
  assert.equal(errors.length, 2);
});

test("attempt exhaustion and throwing onError cannot break the lane", async () => {
  const deliveredIndexes: number[] = [];
  const reported: unknown[] = [];
  const outbox = new RoomCommitOutbox({
    maxAttempts: 1,
    handler: (delivery) => {
      deliveredIndexes.push(delivery.effectIndex);
      if (delivery.effectIndex === 0) throw new Error("permanent");
    },
    onError: (error) => {
      reported.push(error);
      throw new Error("reporter failed");
    }
  });

  outbox.enqueue(commit("room-a", 2, [STATE_EFFECT, CLOSE_EFFECT]));
  await waitUntil(() => outbox.pendingCount === 0);

  assert.deepEqual(deliveredIndexes, [0, 1]);
  assert.equal(
    reported.some((error) => error instanceof RoomCommitDeliveryExhaustedError),
    true
  );
});

test("dispose cancels retries and starts no further deliveries", async () => {
  let nowMs = 1_000;
  const scheduler = new ManualScheduler();
  const deliveries: RoomEffectDelivery[] = [];
  const outbox = new RoomCommitOutbox({
    clock: () => nowMs,
    scheduler,
    handler: (delivery) => {
      deliveries.push(delivery);
      throw new Error("retry");
    }
  });

  outbox.enqueue(commit("room-a", 2));
  await waitUntil(() => scheduler.tasks.size === 1);
  outbox.dispose();
  assert.equal(outbox.pendingCount, 0);
  assert.equal(scheduler.tasks.size, 0);
  assert.throws(
    () => outbox.enqueue(commit("room-a", 3)),
    /ROOM_COMMIT_OUTBOX_DISPOSED/
  );
  await flush();
  assert.equal(deliveries.length, 1);
});

test("capacity overflow is explicit while duplicates remain harmless", () => {
  const outbox = new RoomCommitOutbox({
    capacity: 1,
    handler: async () => new Promise<void>(() => undefined)
  });
  const first = commit("room-a", 2);
  assert.equal(outbox.enqueue(first), true);
  assert.equal(outbox.enqueue(first), false);
  assert.throws(
    () => outbox.enqueue(commit("room-b", 2)),
    RoomCommitOutboxCapacityError
  );
  outbox.dispose();
});

test("runtime commits use presenceSequence as their unique revision", async () => {
  const delivered: RoomEffectDelivery[] = [];
  const outbox = new RoomCommitOutbox({
    handler: (delivery) => {
      delivered.push(delivery);
    }
  });
  const runtimeCommit = {
    before: {},
    after: {
      roomId: "room-presence",
      revision: 7,
      presenceSequence: 11
    },
    effects: [STATE_EFFECT]
  } as unknown as import("../src/rooms/roomRuntime.ts").RoomRuntimeCommit;

  outbox.enqueue(runtimeCommit);
  await waitUntil(() => outbox.pendingCount === 0);
  const first = delivered[0];
  assert.ok(first);
  assert.equal(first.revision, 11);
});

test("effects are copied before asynchronous delivery", async () => {
  const mutable = {
    type: "countdown.cancel",
    countdownId: 1,
    reason: "unready"
  } as RoomEffect;
  let delivered: RoomEffect | null = null;
  const outbox = new RoomCommitOutbox({
    handler: (delivery) => {
      delivered = delivery.effect;
    }
  });
  outbox.enqueue(commit("room-a", 2, [mutable]));
  (mutable as { countdownId: number }).countdownId = 99;

  await waitUntil(() => outbox.pendingCount === 0);
  assert.equal(
    (delivered as { readonly countdownId: number } | null)?.countdownId,
    1
  );
  assert.equal(Object.isFrozen(delivered), true);
});
