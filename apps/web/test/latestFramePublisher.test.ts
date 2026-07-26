import assert from "node:assert/strict";
import test from "node:test";

import {
  LatestFramePublisher,
  type AnimationFrameScheduler
} from "../src/game/hooks/LatestFramePublisher.ts";

class FakeFrameScheduler implements AnimationFrameScheduler {
  #nextHandle = 1;
  readonly #callbacks = new Map<number, FrameRequestCallback>();

  request(callback: FrameRequestCallback): number {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.#callbacks.delete(handle);
  }

  flush(timestamp: number): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) callback(timestamp);
  }

  get pendingCount(): number {
    return this.#callbacks.size;
  }
}

test("240 realtime snapshots commit at most once per 60 display frames", () => {
  const scheduler = new FakeFrameScheduler();
  const published: number[] = [];
  const publisher = new LatestFramePublisher(
    (value: number) => published.push(value),
    scheduler
  );

  for (let displayFrame = 0; displayFrame < 60; displayFrame += 1) {
    for (let snapshot = 0; snapshot < 4; snapshot += 1) {
      publisher.enqueue(displayFrame * 4 + snapshot);
    }
    assert.equal(scheduler.pendingCount, 1);
    scheduler.flush(displayFrame * (1_000 / 60));
  }

  assert.equal(published.length, 60);
  assert.equal(published.at(-1), 239);
});

test("a 240 snapshot burst publishes only its latest value", () => {
  const scheduler = new FakeFrameScheduler();
  const published: number[] = [];
  const publisher = new LatestFramePublisher(
    (value: number) => published.push(value),
    scheduler
  );

  for (let snapshot = 0; snapshot < 240; snapshot += 1) {
    publisher.enqueue(snapshot);
  }
  assert.deepEqual(published, []);
  scheduler.flush(16);
  assert.deepEqual(published, [239]);
});

test("local prediction publishes now and cancels stale realtime work", () => {
  const scheduler = new FakeFrameScheduler();
  const published: string[] = [];
  const publisher = new LatestFramePublisher(
    (value: string) => published.push(value),
    scheduler
  );

  publisher.enqueue("server-old");
  publisher.publishNow("local-new");
  assert.deepEqual(published, ["local-new"]);
  assert.equal(scheduler.pendingCount, 0);
  scheduler.flush(16);
  assert.deepEqual(published, ["local-new"]);
});
