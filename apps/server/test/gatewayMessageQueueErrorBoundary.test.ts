import assert from "node:assert/strict";
import test from "node:test";

import {
  GatewayMessageQueue
} from "../src/gateway/gatewayMessageQueue.ts";

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("throwing error reporter cannot poison the serial tail", async () => {
  const calls: string[] = [];
  const queue = new GatewayMessageQueue({
    capacity: 1,
    onError() {
      throw new Error("reporter failed");
    }
  });

  assert.equal(queue.enqueue(async () => {
    calls.push("failed-work");
    throw new Error("work failed");
  }), true);
  await flush();
  assert.equal(queue.pendingCount, 0);

  assert.equal(queue.enqueue(() => {
    calls.push("next-work");
  }), true);
  await flush();

  assert.deepEqual(calls, ["failed-work", "next-work"]);
  assert.equal(queue.pendingCount, 0);
});
