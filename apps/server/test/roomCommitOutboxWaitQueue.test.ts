import assert from "node:assert/strict";
import test from "node:test";

import type { RoomEffect } from "../../../packages/room-core/src/model.ts";
import {
  prepareRoomOutboxCommit
} from "../src/rooms/roomCommitOutboxModel.ts";
import {
  RoomCommitOutboxWaitQueue
} from "../src/rooms/roomCommitOutboxWaitQueue.ts";

const EFFECT: RoomEffect = {
  type: "room.state_changed",
  revision: 2,
  presenceSequence: 2
};

function prepared() {
  return prepareRoomOutboxCommit({
    roomId: "room-shared-duplicate",
    revision: 1,
    effects: [EFFECT]
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("one waiting key shares one lazy duplicate result", async () => {
  const queue = new RoomCommitOutboxWaitQueue(1);
  const commit = prepared();
  const admitted = queue.add(commit);
  const firstDuplicate = queue.duplicateOf(commit);
  const secondDuplicate = queue.duplicateOf(commit);
  assert.notEqual(firstDuplicate, null);
  assert.strictEqual(secondDuplicate, firstDuplicate);
  let duplicateSettled = false;
  void firstDuplicate!.then(() => {
    duplicateSettled = true;
  });

  await flush();
  assert.equal(duplicateSettled, false);
  const waiting = queue.shift();
  assert.notEqual(waiting, undefined);
  waiting!.resolve(true);

  assert.equal(await admitted, true);
  assert.equal(await firstDuplicate!, false);
  assert.equal(duplicateSettled, true);
});

test("ignored shared duplicate rejection is internally handled", async () => {
  const unhandled: unknown[] = [];
  const capture = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", capture);
  try {
    const queue = new RoomCommitOutboxWaitQueue(1);
    const commit = prepared();
    const admitted = queue.add(commit);
    queue.duplicateOf(commit);
    const rejected = assert.rejects(admitted, /disposed for test/);

    queue.rejectAll(new Error("disposed for test"));
    await rejected;
    await flush();
    await flush();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", capture);
  }
});
