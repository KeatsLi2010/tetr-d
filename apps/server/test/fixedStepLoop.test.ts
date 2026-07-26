import assert from "node:assert/strict";
import test from "node:test";

import {
  FixedStepLoop,
  type FixedStepClock,
  type FixedStepScheduler
} from "../src/matches/fixedStepLoop.ts";

class ManualClock implements FixedStepClock {
  now = 0n;

  nowNs(): bigint {
    return this.now;
  }

  setMilliseconds(value: number): void {
    this.now = BigInt(value) * 1_000_000n;
  }
}

interface ScheduledWake {
  readonly id: number;
  readonly delayMs: number;
  readonly callback: () => void;
  cancelled: boolean;
}

class ManualScheduler implements FixedStepScheduler {
  readonly wakes: ScheduledWake[] = [];
  #nextId = 1;

  schedule(delayMs: number, callback: () => void): ScheduledWake {
    const wake = {
      id: this.#nextId++,
      delayMs,
      callback,
      cancelled: false
    };
    this.wakes.push(wake);
    return wake;
  }

  cancel(value: unknown): void {
    (value as ScheduledWake).cancelled = true;
  }

  runNext(): ScheduledWake {
    const index = this.wakes.findIndex((wake) => !wake.cancelled);
    assert.notEqual(index, -1, "expected a scheduled wake");
    const [wake] = this.wakes.splice(index, 1);
    assert.ok(wake);
    wake.callback();
    return wake;
  }

  next(): ScheduledWake {
    const wake = this.wakes.find((candidate) => !candidate.cancelled);
    assert.ok(wake, "expected a scheduled wake");
    return wake;
  }
}

function setup(options: {
  readonly hz?: number;
  readonly maxCatchUp?: number;
  readonly step?: (frame: number) => void;
  readonly onOverloadChange?: ConstructorParameters<
    typeof FixedStepLoop
  >[0]["onOverloadChange"];
  readonly onStepError?: ConstructorParameters<
    typeof FixedStepLoop
  >[0]["onStepError"];
}) {
  const clock = new ManualClock();
  const scheduler = new ManualScheduler();
  const frames: number[] = [];
  const loop = new FixedStepLoop({
    tickRateHz: options.hz ?? 100,
    maxCatchUpSteps: options.maxCatchUp ?? 4,
    clock,
    scheduler,
    step: options.step ?? ((frame) => frames.push(frame)),
    ...(options.onOverloadChange === undefined
      ? {}
      : { onOverloadChange: options.onOverloadChange }),
    ...(options.onStepError === undefined
      ? {}
      : { onStepError: options.onStepError })
  });
  assert.equal(loop.start(), true);
  return { clock, scheduler, frames, loop };
}

test("does not step before the absolute 240 Hz deadline", () => {
  const context = setup({ hz: 240 });
  assert.equal(context.scheduler.next().delayMs, 5);

  context.clock.now = 4_166_666n;
  context.scheduler.runNext();
  assert.deepEqual(context.frames, []);

  context.clock.now = 4_166_667n;
  context.scheduler.runNext();
  assert.deepEqual(context.frames, [1]);
  assert.equal(context.loop.serverFrame, 1);
});

test("jitter catches up to the absolute target without drift", () => {
  const context = setup({ hz: 100, maxCatchUp: 10 });

  for (const milliseconds of [11, 36, 101]) {
    context.clock.setMilliseconds(milliseconds);
    context.scheduler.runNext();
  }

  assert.deepEqual(
    context.frames,
    Array.from({ length: 10 }, (_, index) => index + 1)
  );
  assert.equal(context.loop.serverFrame, 10);
});

test("catch-up batches are bounded and no logical frames are lost", () => {
  const changes: string[] = [];
  const context = setup({
    hz: 100,
    maxCatchUp: 3,
    onOverloadChange: (event) => changes.push(event.kind)
  });
  context.clock.setMilliseconds(95);

  context.scheduler.runNext();
  assert.deepEqual(context.frames, [1, 2, 3]);
  assert.deepEqual(changes, ["entered"]);

  context.scheduler.runNext();
  assert.deepEqual(context.frames, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(changes, ["entered"]);

  context.scheduler.runNext();
  assert.deepEqual(
    context.frames,
    [1, 2, 3, 4, 5, 6, 7, 8, 9]
  );
  assert.deepEqual(changes, ["entered", "recovered"]);
  assert.equal(context.loop.overloaded, false);
});

test("a failed step can retry the same frame or stop explicitly", () => {
  const attempts: number[] = [];
  let failed = false;
  const retrying = setup({
    hz: 10,
    maxCatchUp: 5,
    step(frame) {
      attempts.push(frame);
      if (frame === 2 && !failed) {
        failed = true;
        throw new Error("transient");
      }
    },
    onStepError: () => "retry"
  });
  retrying.clock.setMilliseconds(300);
  retrying.scheduler.runNext();
  assert.equal(retrying.loop.serverFrame, 1);
  retrying.scheduler.runNext();
  assert.deepEqual(attempts, [1, 2, 2, 3]);
  assert.equal(retrying.loop.state, "running");

  const stopping = setup({
    hz: 10,
    step() {
      throw new Error("fatal");
    },
    onStepError: () => "stop"
  });
  stopping.clock.setMilliseconds(100);
  stopping.scheduler.runNext();
  assert.equal(stopping.loop.state, "stopped");
});

test("pause freezes elapsed time and close fences stale callbacks", () => {
  const context = setup({ hz: 100 });
  const stale = context.scheduler.next();

  context.clock.setMilliseconds(5);
  assert.equal(context.loop.pause(), true);
  context.clock.setMilliseconds(1_005);
  assert.equal(context.loop.resume(), true);
  stale.callback();
  assert.deepEqual(context.frames, []);

  context.clock.setMilliseconds(1_010);
  context.scheduler.runNext();
  assert.deepEqual(context.frames, [1]);

  const afterResume = context.scheduler.next();
  context.loop.close();
  context.loop.close();
  afterResume.callback();
  assert.equal(context.loop.state, "closed");
  assert.deepEqual(context.frames, [1]);
});

test("rejects invalid loop rates and catch-up limits", () => {
  const step = () => undefined;
  assert.throws(
    () =>
      new FixedStepLoop({
        tickRateHz: 0,
        maxCatchUpSteps: 1,
        step
      }),
    /tickRateHz/
  );
  assert.throws(
    () =>
      new FixedStepLoop({
        tickRateHz: 240,
        maxCatchUpSteps: 1.5,
        step
      }),
    /maxCatchUpSteps/
  );
});
