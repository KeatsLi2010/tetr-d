import assert from "node:assert/strict";
import test from "node:test";

import type { RoomEffect } from "../../../packages/room-core/src/model.ts";
import { RoomCommitOutbox } from "../src/rooms/roomCommitOutbox.ts";

const EFFECT: RoomEffect = {
  type: "room.state_changed",
  revision: 2,
  presenceSequence: 2
};

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("disposing a lone capacity waiter has no hidden rejection", async () => {
  const unhandled: unknown[] = [];
  const capture = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", capture);
  try {
    const outbox = new RoomCommitOutbox({
      capacity: 1,
      handler: () => new Promise<void>(() => undefined)
    });
    outbox.enqueue({ roomId: "room-first", revision: 1, effects: [EFFECT] });
    const waiting = outbox.enqueueDurably({
      roomId: "room-waiting",
      revision: 1,
      effects: [EFFECT]
    });
    const rejected = assert.rejects(
      waiting,
      /ROOM_COMMIT_OUTBOX_DISPOSED/
    );

    outbox.dispose();
    await rejected;
    await flush();
    await flush();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", capture);
  }
});
