import assert from "node:assert/strict";
import test from "node:test";

import type { RoomEffect } from "../../../packages/room-core/src/model.ts";
import {
  RoomCommitOutbox,
  RoomCommitOutboxCapacityError,
  RoomCommitOutboxConflictError,
  RoomCommitOutboxWaitCapacityError
} from "../src/rooms/roomCommitOutbox.ts";
import type {
  RoomEffectDelivery
} from "../src/rooms/roomCommitOutbox.ts";

const EFFECT: RoomEffect = {
  type: "room.state_changed",
  revision: 2,
  presenceSequence: 2
};
const OTHER_EFFECT: RoomEffect = {
  type: "room.closed",
  reason: "expired"
};

function commit(
  roomId: string,
  revision: number,
  effects: readonly RoomEffect[] = [EFFECT]
) {
  return { roomId, revision, effects } as const;
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

test("durable enqueue waits FIFO and duplicate resolves after admission", async () => {
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const deliveries: RoomEffectDelivery[] = [];
  const outbox = new RoomCommitOutbox({
    capacity: 1,
    waitingCapacity: 2,
    handler: async (delivery) => {
      deliveries.push(delivery);
      if (delivery.roomId === "room-first") await firstBlocked;
    }
  });

  outbox.enqueue(commit("room-first", 1));
  await waitUntil(() => deliveries.length === 1);
  const secondCommit = commit("room-second", 1);
  const second = outbox.enqueueDurably(secondCommit);
  const secondDuplicate = outbox.enqueueDurably(secondCommit);
  const third = outbox.enqueueDurably(commit("room-third", 1));
  let secondSettled = false;
  void second.then(() => {
    secondSettled = true;
  });

  await flush();
  assert.equal(outbox.waitingCount, 2);
  assert.equal(secondSettled, false);
  assert.equal(deliveries.length, 1);

  releaseFirst();
  assert.deepEqual(
    await Promise.all([second, secondDuplicate, third]),
    [true, false, true]
  );
  await waitUntil(() => outbox.pendingCount === 0);

  assert.deepEqual(
    deliveries.map((delivery) => delivery.roomId),
    ["room-first", "room-second", "room-third"]
  );
  const secondDeliveries = deliveries.filter(
    (delivery) => delivery.roomId === "room-second"
  );
  assert.equal(secondDeliveries.length, 1);
  assert.match(secondDeliveries[0]!.deliveryId, /:1:0$/);
  assert.equal(outbox.waitingCount, 0);
});

test("waiting capacity is bounded and sync enqueue cannot lie", async () => {
  const outbox = new RoomCommitOutbox({
    capacity: 1,
    waitingCapacity: 1,
    handler: () => new Promise<void>(() => undefined)
  });
  outbox.enqueue(commit("room-first", 1));
  const waitingCommit = commit("room-waiting", 1);
  const waiting = outbox.enqueueDurably(waitingCommit);

  assert.throws(
    () => outbox.enqueue(waitingCommit),
    RoomCommitOutboxCapacityError
  );
  assert.throws(
    () => outbox.enqueue(commit("room-waiting", 1, [OTHER_EFFECT])),
    RoomCommitOutboxConflictError
  );
  await assert.rejects(
    outbox.enqueueDurably(commit("room-overflow", 1)),
    RoomCommitOutboxWaitCapacityError
  );

  const disposed = assert.rejects(waiting, /ROOM_COMMIT_OUTBOX_DISPOSED/);
  outbox.dispose();
  await disposed;
  assert.equal(outbox.waitingCount, 0);
});
