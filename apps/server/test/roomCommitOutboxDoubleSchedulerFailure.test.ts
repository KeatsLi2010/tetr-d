import assert from "node:assert/strict";
import test from "node:test";

import type { RoomEffect } from "../../../packages/room-core/src/model.ts";
import {
  RoomCommitOutbox,
  RoomCommitRetryScheduleFailedError
} from "../src/rooms/roomCommitOutbox.ts";
import type {
  RoomCommitOutboxScheduler
} from "../src/rooms/roomCommitOutbox.ts";

const EFFECT: RoomEffect = {
  type: "room.state_changed",
  revision: 2,
  presenceSequence: 2
};

class BrokenScheduler implements RoomCommitOutboxScheduler {
  calls = 0;

  schedule(): unknown {
    this.calls += 1;
    throw new Error("scheduler unavailable");
  }

  cancel(): void {}
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("dual scheduler failure reports and preserves the pending effect", async () => {
  const primary = new BrokenScheduler();
  const recovery = new BrokenScheduler();
  const reported: unknown[] = [];
  let deliveries = 0;
  const outbox = new RoomCommitOutbox({
    scheduler: primary,
    recoveryScheduler: recovery,
    handler: () => {
      deliveries += 1;
      throw new Error("delivery failed");
    },
    onError: (error) => reported.push(error)
  });

  outbox.enqueue({
    roomId: "room-fail-closed",
    revision: 1,
    effects: [EFFECT]
  });
  await flush();
  await flush();
  await flush();

  assert.equal(primary.calls, 1);
  assert.equal(recovery.calls, 1);
  assert.equal(deliveries, 1);
  assert.equal(outbox.pendingCount, 1);
  assert.equal(
    reported.some(
      (error) => error instanceof RoomCommitRetryScheduleFailedError
    ),
    true
  );
  outbox.dispose();
  assert.equal(outbox.pendingCount, 0);
});
