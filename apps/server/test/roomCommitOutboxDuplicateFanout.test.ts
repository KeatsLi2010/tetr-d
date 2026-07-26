import assert from "node:assert/strict";
import test from "node:test";

import type { RoomEffect } from "../../../packages/room-core/src/model.ts";
import { RoomCommitOutbox } from "../src/rooms/roomCommitOutbox.ts";

const EFFECT: RoomEffect = {
  type: "room.state_changed",
  revision: 2,
  presenceSequence: 2
};

test("waiting duplicates expose one stable shared result", async () => {
  const outbox = new RoomCommitOutbox({
    capacity: 1,
    handler: () => new Promise<void>(() => undefined)
  });
  outbox.enqueue({
    roomId: "room-blocker",
    revision: 1,
    effects: [EFFECT]
  });
  const commit = {
    roomId: "room-duplicate",
    revision: 1,
    effects: [EFFECT]
  } as const;
  const first = outbox.enqueueDurably(commit);
  const duplicate = outbox.enqueueDurably(commit);
  const duplicateAgain = outbox.enqueueDurably(commit);

  assert.notStrictEqual(first, duplicate);
  assert.strictEqual(duplicateAgain, duplicate);
  const settled = Promise.allSettled([first, duplicate]);
  outbox.dispose();
  const results = await settled;
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "rejected"]
  );
});
