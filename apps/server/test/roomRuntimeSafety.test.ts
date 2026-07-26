import assert from "node:assert/strict";
import test from "node:test";

import type {
  RoomCommand,
  RoomState
} from "../../../packages/room-core/src/model.ts";
import {
  createRoom,
  transitionRoom
} from "../../../packages/room-core/src/room.ts";
import {
  RoomActor
} from "../src/roomActor.ts";
import type {
  RoomActorPrincipal
} from "../src/roomActor.ts";
import {
  RoomRuntime
} from "../src/rooms/roomRuntime.ts";
import type {
  RoomScheduler,
  RoomTaskCallback
} from "../src/rooms/roomScheduler.ts";

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

class ManualScheduler implements RoomScheduler {
  readonly tasks = new Map<
    string,
    { readonly deadlineMs: number; readonly callback: RoomTaskCallback }
  >();
  readonly cancelCalls: string[] = [];
  throwOnCancel = false;

  schedule(
    key: string,
    deadlineMs: number,
    callback: RoomTaskCallback
  ): void {
    this.tasks.set(key, { deadlineMs, callback });
  }

  cancel(key: string): void {
    this.cancelCalls.push(key);
    if (this.throwOnCancel) throw new Error(`cancel failed: ${key}`);
    this.tasks.delete(key);
  }

  cancelAll(): void {
    this.tasks.clear();
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

  #keyFor(logicalKey: string): string | undefined {
    return [...this.tasks.keys()].find((key) =>
      key.endsWith(`:${logicalKey}`)
    );
  }

  private keyFor(logicalKey: string): string | undefined {
    return this.#keyFor(logicalKey);
  }
}

function committed(state: RoomState, command: RoomCommand): RoomState {
  const result = transitionRoom(state, command);
  assert.equal(result.kind, "committed");
  if (result.kind !== "committed") throw new Error("Expected commit.");
  return result.state;
}

function lobbyState(): RoomState {
  return createRoom({
    roomId: "runtime-safety",
    roomCode: "SAF234",
    creator: HOST.player,
    connectionId: HOST.connectionId,
    nowMs: 1_000
  });
}

function disconnectedState(): RoomState {
  let state = lobbyState();
  state = committed(state, {
    type: "member.join",
    requestId: "join-guest",
    player: GUEST.player,
    connectionId: GUEST.connectionId,
    participation: "player",
    atMs: 1_100
  });
  return committed(state, {
    type: "connection.lost",
    playerId: GUEST.player.playerId,
    connectionId: GUEST.connectionId,
    expectedConnectionEpoch: 0,
    atMs: 1_200
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("Condition was not reached.");
}

const PENDING = Symbol("pending");

async function outcomeAfterTurns(
  promise: Promise<unknown>
): Promise<unknown | typeof PENDING> {
  let outcome: unknown | typeof PENDING = PENDING;
  void promise.then(
    (value) => {
      outcome = value;
    },
    (error: unknown) => {
      outcome = error;
    }
  );
  await flush();
  await flush();
  return outcome;
}

function assertCapacityError(value: unknown): void {
  assert.ok(value instanceof Error);
  assert.equal(value.name, "RoomRuntimeQueueCapacityError");
  assert.equal(value.message, "ROOM_RUNTIME_QUEUE_CAPACITY_REACHED");
}

test("dispose reports every cancel error and still wakes dispatch", async () => {
  const scheduler = new ManualScheduler();
  const errors: unknown[] = [];
  let publishEntered = false;
  const runtime = new RoomRuntime(
    new RoomActor(disconnectedState(), { now: () => 2_000 }),
    {
      scheduler,
      now: () => 2_000,
      onCommit() {
        publishEntered = true;
        return new Promise<void>(() => undefined);
      },
      onError: (error) => errors.push(error)
    }
  );
  const pending = runtime.dispatchUser(HOST, {
    type: "settings.update",
    requestId: "settings",
    expectedRevision: runtime.snapshot.revision,
    patch: { targetWins: 5 }
  });
  await waitUntil(() => publishEntered);
  const cancelBaseline = scheduler.cancelCalls.length;
  const errorBaseline = errors.length;
  scheduler.throwOnCancel = true;

  assert.doesNotThrow(() => runtime.dispose());
  await assert.rejects(pending, /disposed/);
  assert.equal(scheduler.cancelCalls.length - cancelBaseline, 2);
  assert.equal(errors.length - errorBaseline, 2);
  const cancelCount = scheduler.cancelCalls.length;
  runtime.dispose();
  assert.equal(scheduler.cancelCalls.length, cancelCount);
});

test("dispatch lane rejects user and system overflow with a stable error", async () => {
  const scheduler = new ManualScheduler();
  let publishEntered = false;
  const runtime = new RoomRuntime(
    new RoomActor(lobbyState(), { now: () => 2_000 }),
    {
      scheduler,
      now: () => 2_000,
      dispatchQueueCapacity: 2,
      onCommit() {
        publishEntered = true;
        return new Promise<void>(() => undefined);
      }
    }
  );
  const first = runtime.dispatchUser(HOST, {
    type: "settings.update",
    requestId: "first",
    expectedRevision: runtime.snapshot.revision,
    patch: { targetWins: 5 }
  });
  await waitUntil(() => publishEntered);
  const second = runtime.dispatchSystem({ type: "timer.room_expired" });
  const overflowUser = runtime.dispatchUser(HOST, {
    type: "settings.update",
    requestId: "overflow-user",
    expectedRevision: runtime.snapshot.revision,
    patch: { targetWins: 3 }
  });
  const overflowSystem = runtime.dispatchSystem({
    type: "timer.room_expired"
  });
  const overflowUserOutcome = outcomeAfterTurns(overflowUser);
  const overflowSystemOutcome = outcomeAfterTurns(overflowSystem);

  try {
    assertCapacityError(await overflowUserOutcome);
    assertCapacityError(await overflowSystemOutcome);
  } finally {
    runtime.dispose();
    await Promise.allSettled([
      first,
      second,
      overflowUser,
      overflowSystem
    ]);
  }
});

test("commit retries do not accumulate dispose Promise listeners", async () => {
  const scheduler = new ManualScheduler();
  const promisePrototype = Promise.prototype as unknown as {
    then: (
      onFulfilled?: ((value: unknown) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null
    ) => Promise<unknown>;
  };
  const originalThen = promisePrototype.then;
  let disposeListenerRegistrations = 0;
  promisePrototype.then = function (
    this: Promise<unknown>,
    onFulfilled,
    onRejected
  ): Promise<unknown> {
    if (
      typeof onFulfilled === "function" &&
      String(onFulfilled).includes("Room runtime is disposed.")
    ) {
      disposeListenerRegistrations += 1;
    }
    return originalThen.call(this, onFulfilled, onRejected);
  };

  let attempts = 0;
  const runtime = new RoomRuntime(
    new RoomActor(lobbyState(), { now: () => 2_000 }),
    {
      scheduler,
      now: () => 2_000,
      commitRetryBaseMs: 1,
      commitRetryMaxMs: 1,
      onCommit() {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary publish failure");
      }
    }
  );
  try {
    const pending = runtime.dispatchUser(HOST, {
      type: "settings.update",
      requestId: "retry",
      expectedRevision: runtime.snapshot.revision,
      patch: { targetWins: 5 }
    });
    await waitUntil(() => scheduler.has("commit-publish"));
    await scheduler.run("commit-publish");
    await waitUntil(() => scheduler.has("commit-publish"));
    await scheduler.run("commit-publish");
    await pending;

    assert.equal(attempts, 3);
    assert.equal(disposeListenerRegistrations, 0);
  } finally {
    promisePrototype.then = originalThen;
    runtime.dispose();
  }
});
