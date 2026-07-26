import assert from "node:assert/strict";
import test from "node:test";

import { createRoom } from "../../../packages/room-core/src/room.ts";
import { RoomActor } from "../src/roomActor.ts";
import type { RoomActorPrincipal } from "../src/roomActor.ts";
import { RoomRuntime } from "../src/rooms/roomRuntime.ts";
import type {
  RoomScheduler,
  RoomTaskCallback
} from "../src/rooms/roomScheduler.ts";

class ManualScheduler implements RoomScheduler {
  readonly tasks = new Map<
    string,
    { readonly deadlineMs: number; readonly callback: RoomTaskCallback }
  >();

  schedule(
    key: string,
    deadlineMs: number,
    callback: RoomTaskCallback
  ): void {
    const current = this.tasks.get(key);
    if (current?.deadlineMs === deadlineMs) return;
    this.tasks.set(key, { deadlineMs, callback });
  }

  cancel(key: string): void {
    this.tasks.delete(key);
  }

  cancelAll(): void {
    this.tasks.clear();
  }

  keyFor(logicalKey: string): string | undefined {
    return [...this.tasks.keys()].find((key) =>
      key.endsWith(`:${logicalKey}`)
    );
  }

  has(logicalKey: string): boolean {
    return this.keyFor(logicalKey) !== undefined;
  }

  async run(logicalKey: string): Promise<void> {
    const key = this.keyFor(logicalKey);
    if (key === undefined) throw new Error(`Missing task: ${logicalKey}`);
    const task = this.tasks.get(key);
    if (task === undefined) throw new Error(`Missing task: ${logicalKey}`);
    this.tasks.delete(key);
    await task.callback();
  }
}

const HOST: RoomActorPrincipal = {
  sessionId: "session-host",
  player: { playerId: "host", displayName: "Host" },
  connectionId: "connection-host",
  connectionGeneration: 0
};
const GUEST: RoomActorPrincipal = {
  sessionId: "session-guest",
  player: { playerId: "guest", displayName: "Guest" },
  connectionId: "connection-guest",
  connectionGeneration: 0
};

function setup(options: {
  readonly scheduler?: ManualScheduler;
  readonly matchIdFactory?: () => string;
  readonly onError?: (error: unknown) => void;
} = {}): {
  readonly runtime: RoomRuntime;
  readonly scheduler: ManualScheduler;
  readonly commits: {
    readonly effects: readonly { readonly type: string }[];
  }[];
  setNow(value: number): void;
} {
  let nowMs = 1_100;
  const scheduler = options.scheduler ?? new ManualScheduler();
  const commits: {
    readonly effects: readonly { readonly type: string }[];
  }[] = [];
  const actor = new RoomActor(
    createRoom({
      roomId: "runtime-room",
      roomCode: "RUN234",
      creator: HOST.player,
      connectionId: HOST.connectionId,
      nowMs: 1_000
    }),
    { now: () => nowMs }
  );
  const runtime = new RoomRuntime(actor, {
    scheduler,
    matchIdFactory: options.matchIdFactory ?? (() => "match-runtime"),
    now: () => nowMs,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    onCommit: (commit) => {
      commits.push(commit);
    }
  });
  return {
    runtime,
    scheduler,
    commits,
    setNow(value) {
      nowMs = value;
    }
  };
}

async function prepareCountdown(context: ReturnType<typeof setup>) {
  await context.runtime.dispatchUser(GUEST, {
    type: "member.join",
    requestId: "join-guest",
    participation: "player"
  });
  await context.runtime.dispatchUser(HOST, {
    type: "ready.set",
    requestId: "ready-host",
    expectedRevision: context.runtime.snapshot.revision,
    ready: true
  });
  const guestReady = {
    type: "ready.set",
    requestId: "ready-guest",
    expectedRevision: context.runtime.snapshot.revision,
    ready: true
  } as const;
  const result = await context.runtime.dispatchUser(GUEST, guestReady);
  return { guestReady, result };
}

test("runtime schedules one countdown and replay executes no effects", async () => {
  const context = setup();
  const { guestReady, result } = await prepareCountdown(context);
  assert.equal(result.receipt.kind, "committed");
  assert.equal(context.scheduler.has("countdown"), true);
  const schedulesBefore = context.commits
    .flatMap((commit) => commit.effects)
    .filter((effect) => effect.type === "countdown.schedule").length;

  const replay = await context.runtime.dispatchUser(GUEST, guestReady);

  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.effects, []);
  assert.equal(context.commits
    .flatMap((commit) => commit.effects)
    .filter((effect) => effect.type === "countdown.schedule").length,
  schedulesBefore);
});

test("countdown task starts exactly one match and removes itself", async () => {
  const context = setup();
  await prepareCountdown(context);
  const startsAtMs = context.runtime.snapshot.countdown!.startsAtMs;
  context.setNow(startsAtMs);

  await context.scheduler.run("countdown");

  assert.equal(context.runtime.snapshot.phase, "playing");
  assert.equal(context.scheduler.has("countdown"), false);
  const starts = context.commits
    .flatMap((commit) => commit.effects)
    .filter((effect) => effect.type === "match.start");
  assert.equal(starts.length, 1);
});

test("unready cancels the scheduled countdown before it can fire", async () => {
  const context = setup();
  await prepareCountdown(context);

  await context.runtime.dispatchUser(HOST, {
    type: "ready.set",
    requestId: "unready-host",
    expectedRevision: context.runtime.snapshot.revision,
    ready: false
  });

  assert.equal(context.runtime.snapshot.phase, "lobby");
  assert.equal(context.scheduler.has("countdown"), false);
  assert.deepEqual(context.runtime.snapshot.ready, [false, false]);
});

test("an early countdown callback is reconciled instead of being lost", async () => {
  const context = setup();
  await prepareCountdown(context);

  await context.scheduler.run("countdown");

  assert.equal(context.runtime.snapshot.phase, "countdown");
  assert.notEqual(context.runtime.snapshot.countdown, null);
  assert.equal(context.scheduler.has("countdown"), true);

  context.setNow(context.runtime.snapshot.countdown!.startsAtMs);
  await context.scheduler.run("countdown");
  assert.equal(context.runtime.snapshot.phase, "playing");
});

test("a transient match id failure re-arms the countdown", async () => {
  let attempts = 0;
  const errors: unknown[] = [];
  const context = setup({
    matchIdFactory() {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary entropy failure");
      return "match-after-retry";
    },
    onError: (error) => {
      errors.push(error);
    }
  });
  await prepareCountdown(context);
  context.setNow(context.runtime.snapshot.countdown!.startsAtMs);

  await context.scheduler.run("countdown");
  assert.equal(context.runtime.snapshot.phase, "countdown");
  assert.equal(context.scheduler.has("countdown"), true);
  assert.equal(errors.length, 1);

  await context.scheduler.run("countdown");
  assert.equal(context.runtime.snapshot.phase, "playing");
});

test("replay heals a transient scheduler failure without replaying effects", async () => {
  class ThrowOnceScheduler extends ManualScheduler {
    failed = false;

    override schedule(
      key: string,
      deadlineMs: number,
      callback: RoomTaskCallback
    ): void {
      if (!this.failed && key.endsWith(":countdown")) {
        this.failed = true;
        throw new Error("temporary scheduler failure");
      }
      super.schedule(key, deadlineMs, callback);
    }
  }

  const scheduler = new ThrowOnceScheduler();
  const context = setup({ scheduler });
  const { guestReady } = await prepareCountdown(context);
  assert.equal(scheduler.has("countdown"), false);
  const commitCount = context.commits.length;

  const replay = await context.runtime.dispatchUser(GUEST, guestReady);

  assert.equal(replay.replayed, true);
  assert.equal(scheduler.has("countdown"), true);
  assert.equal(context.commits.length, commitCount);
});

test("dispose fences a countdown callback that was already captured", async () => {
  const context = setup();
  await prepareCountdown(context);
  const key = context.scheduler.keyFor("countdown");
  assert.notEqual(key, undefined);
  const callback = context.scheduler.tasks.get(key!)?.callback;
  assert.notEqual(callback, undefined);

  context.runtime.dispose();
  await callback!();

  assert.equal(context.runtime.snapshot.phase, "countdown");
  assert.equal(context.scheduler.tasks.size, 0);
});
