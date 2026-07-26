import assert from "node:assert/strict";
import test from "node:test";

import type { RoomEffect } from "../../../packages/room-core/src/model.ts";
import {
  RoomCommitOutbox
} from "../src/rooms/roomCommitOutbox.ts";
import type {
  RoomCommitOutboxScheduler,
  RoomEffectDelivery
} from "../src/rooms/roomCommitOutbox.ts";

const EFFECT: RoomEffect = {
  type: "room.state_changed",
  revision: 2,
  presenceSequence: 2
};

class ThrowingScheduler implements RoomCommitOutboxScheduler {
  scheduleCalls = 0;

  schedule(): unknown {
    this.scheduleCalls += 1;
    throw new Error("primary scheduler unavailable");
  }

  cancel(): void {
    throw new Error("primary scheduler never returned a handle");
  }
}

class ManualScheduler implements RoomCommitOutboxScheduler {
  readonly tasks = new Map<
    number,
    { readonly deadlineMs: number; readonly callback: () => void }
  >();
  cancelCalls = 0;
  #nextId = 1;

  schedule(deadlineMs: number, callback: () => void): number {
    const id = this.#nextId++;
    this.tasks.set(id, { deadlineMs, callback });
    return id;
  }

  cancel(handle: unknown): void {
    this.cancelCalls += 1;
    this.tasks.delete(handle as number);
  }

  runNext(): void {
    const entry = this.tasks.entries().next().value;
    if (entry === undefined) throw new Error("Missing recovery task.");
    this.tasks.delete(entry[0]);
    entry[1].callback();
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(
  predicate: () => boolean,
  attempts = 30
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("Condition was not reached.");
}

test("scheduler failure uses one fallback handle and resumes the lane", async () => {
  const primary = new ThrowingScheduler();
  const recovery = new ManualScheduler();
  const attempts: RoomEffectDelivery[] = [];
  const reported: unknown[] = [];
  const outbox = new RoomCommitOutbox({
    clock: () => 1_000,
    scheduler: primary,
    recoveryScheduler: recovery,
    baseRetryMs: 25,
    maxRetryMs: 25,
    handler: (delivery) => {
      attempts.push(delivery);
      if (delivery.attempt === 1) throw new Error("temporary delivery error");
    },
    onError: (error) => {
      reported.push(error);
      throw new Error("reporter failure");
    }
  });

  outbox.enqueue({ roomId: "room-fallback", revision: 1, effects: [EFFECT] });
  await waitUntil(() => recovery.tasks.size === 1);
  assert.equal(primary.scheduleCalls, 1);
  assert.equal(recovery.tasks.size, 1);
  assert.equal([...recovery.tasks.values()][0]?.deadlineMs, 1_025);
  assert.equal(outbox.pendingCount, 1);

  recovery.runNext();
  await waitUntil(() => outbox.pendingCount === 0);
  assert.deepEqual(attempts.map((delivery) => delivery.attempt), [1, 2]);
  assert.equal(new Set(attempts.map((value) => value.deliveryId)).size, 1);
  assert.equal(reported.length, 2);
});

test("dispose cancels the active fallback instead of retrying", async () => {
  const primary = new ThrowingScheduler();
  const recovery = new ManualScheduler();
  let deliveries = 0;
  const outbox = new RoomCommitOutbox({
    scheduler: primary,
    recoveryScheduler: recovery,
    handler: () => {
      deliveries += 1;
      throw new Error("retry");
    }
  });

  outbox.enqueue({ roomId: "room-dispose", revision: 1, effects: [EFFECT] });
  await waitUntil(() => recovery.tasks.size === 1);
  outbox.dispose();

  assert.equal(recovery.cancelCalls, 1);
  assert.equal(recovery.tasks.size, 0);
  await flush();
  assert.equal(deliveries, 1);
});
