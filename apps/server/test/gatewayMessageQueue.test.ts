import assert from "node:assert/strict";
import test from "node:test";

import {
  GatewayMessageQueue
} from "../src/gateway/gatewayMessageQueue.ts";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("overflow work is not retained in the serial tail", async () => {
  const release = deferred();
  const calls: string[] = [];
  const queue = new GatewayMessageQueue({
    capacity: 2,
    onError: (error) => {
      throw error;
    }
  });

  assert.equal(queue.enqueue(async () => {
    calls.push("running");
    await release.promise;
  }), true);
  assert.equal(queue.enqueue(() => {
    calls.push("queued");
  }), true);
  assert.equal(queue.enqueue(() => {
    calls.push("overflow");
  }), false);
  assert.equal(queue.pendingCount, 2);

  await flush();
  assert.deepEqual(calls, ["running"]);
  release.resolve();
  await flush();
  await flush();
  assert.deepEqual(calls, ["running", "queued"]);
  assert.equal(queue.pendingCount, 0);
});

test("success and failure release capacity and invalid limits fail fast", async () => {
  const errors: unknown[] = [];
  const queue = new GatewayMessageQueue({
    capacity: 1,
    onError: (error) => errors.push(error)
  });

  assert.equal(queue.enqueue(async () => {
    throw new Error("injected");
  }), true);
  await flush();
  assert.equal(queue.pendingCount, 0);
  assert.equal(errors.length, 1);

  assert.equal(queue.enqueue(() => undefined), true);
  await flush();
  assert.equal(queue.pendingCount, 0);
  assert.throws(
    () => new GatewayMessageQueue({ capacity: 0, onError: () => undefined }),
    /Invalid message queue capacity/
  );
  assert.throws(
    () => new GatewayMessageQueue({ capacity: 1.5, onError: () => undefined }),
    /Invalid message queue capacity/
  );
});
