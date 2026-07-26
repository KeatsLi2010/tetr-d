import assert from "node:assert/strict";
import test from "node:test";

import {
  createRoom,
  transitionRoom
} from "../../../packages/room-core/src/room.ts";
import type {
  RoomCommand,
  RoomState
} from "../../../packages/room-core/src/model.ts";
import { RoomActor } from "../src/roomActor.ts";
import type {
  RoomActorPrincipal
} from "../src/roomActor.ts";
import {
  RoomCommitOutbox
} from "../src/rooms/roomCommitOutbox.ts";
import type {
  RoomEffectDelivery
} from "../src/rooms/roomCommitOutbox.ts";
import {
  RoomRuntime
} from "../src/rooms/roomRuntime.ts";
import type {
  RoomRuntimeCommit
} from "../src/rooms/roomRuntime.ts";
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

  deadline(logicalKey: string): number | undefined {
    const key = this.keyFor(logicalKey);
    return key === undefined ? undefined : this.tasks.get(key)?.deadlineMs;
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

function committed(state: RoomState, command: RoomCommand): RoomState {
  const result = transitionRoom(state, command);
  assert.equal(result.kind, "committed");
  if (result.kind !== "committed") throw new Error("Expected commit.");
  return result.state;
}

function countdownState(): RoomState {
  let state = createRoom({
    roomId: "runtime-pressure",
    roomCode: "RUN235",
    creator: HOST.player,
    connectionId: HOST.connectionId,
    nowMs: 1_000
  });
  state = committed(state, {
    type: "member.join",
    requestId: "join-guest",
    player: GUEST.player,
    connectionId: GUEST.connectionId,
    participation: "player",
    atMs: 1_100
  });
  state = committed(state, {
    type: "ready.set",
    requestId: "ready-host",
    actorPlayerId: HOST.player.playerId,
    expectedRevision: state.revision,
    ready: true,
    atMs: 1_200
  });
  return committed(state, {
    type: "ready.set",
    requestId: "ready-guest",
    actorPlayerId: GUEST.player.playerId,
    expectedRevision: state.revision,
    ready: true,
    atMs: 1_300
  });
}

function lobbyActor(now: () => number): RoomActor {
  return new RoomActor(
    createRoom({
      roomId: "runtime-retry",
      roomCode: "RUN236",
      creator: HOST.player,
      connectionId: HOST.connectionId,
      nowMs: 1_000
    }),
    { now }
  );
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(
  predicate: () => boolean,
  attempts = 30
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("Condition was not reached.");
}

test("capacity saturation drains without losing match.start", async () => {
  let releaseBlocker!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const deliveries: RoomEffectDelivery[] = [];
  const outbox = new RoomCommitOutbox({
    capacity: 1,
    handler: async (delivery) => {
      deliveries.push(delivery);
      if (delivery.roomId === "outbox-blocker") await blocked;
    }
  });
  outbox.enqueue({
    roomId: "outbox-blocker",
    revision: 1,
    effects: [{
      type: "room.state_changed",
      revision: 1,
      presenceSequence: 1
    }]
  });
  await waitUntil(() => deliveries.length === 1);

  const state = countdownState();
  let nowMs = state.countdown!.startsAtMs;
  const scheduler = new ManualScheduler();
  const runtime = new RoomRuntime(
    new RoomActor(state, { now: () => nowMs }),
    {
      scheduler,
      now: () => nowMs,
      matchIdFactory: () => "match-pressure",
      onCommit: async (commit) => {
        await outbox.enqueueDurably(commit);
      }
    }
  );

  const timer = scheduler.run("countdown");
  let timerSettled = false;
  void timer.then(() => {
    timerSettled = true;
  });
  await waitUntil(
    () => runtime.snapshot.phase === "playing" && outbox.waitingCount === 1
  );
  await flush();
  assert.equal(timerSettled, false);
  assert.equal(
    deliveries.some((delivery) => delivery.effect.type === "match.start"),
    false
  );

  releaseBlocker();
  await timer;
  await waitUntil(() => outbox.pendingCount === 0);
  const starts = deliveries.filter(
    (delivery) => delivery.effect.type === "match.start"
  );
  assert.equal(starts.length, 1);
  const start = starts[0]!;
  assert.equal(start.revision, runtime.snapshot.presenceSequence);
  assert.match(
    start.deliveryId,
    new RegExp(`:${start.revision}:${start.effectIndex}$`)
  );
  assert.equal(scheduler.has("countdown"), false);
});

test("commit retry keeps later actor mutations behind the same commit", async () => {
  let nowMs = 2_000;
  const scheduler = new ManualScheduler();
  const attempts: RoomRuntimeCommit[] = [];
  const accepted: RoomRuntimeCommit[] = [];
  const errors: unknown[] = [];
  const runtime = new RoomRuntime(lobbyActor(() => nowMs), {
    scheduler,
    now: () => nowMs,
    commitRetryBaseMs: 100,
    commitRetryMaxMs: 1_000,
    onCommit: (commit) => {
      attempts.push(commit);
      if (attempts.length === 1) throw new Error("temporary publish error");
      accepted.push(commit);
    },
    onError: (error) => errors.push(error)
  });

  const first = runtime.dispatchUser(GUEST, {
    type: "member.join",
    requestId: "join-guest",
    participation: "player"
  });
  await waitUntil(() => scheduler.has("commit-publish"));
  assert.equal(scheduler.deadline("commit-publish"), 2_100);
  assert.equal(runtime.snapshot.members.guest !== undefined, true);
  const nextRevision = runtime.snapshot.revision;
  const second = runtime.dispatchUser(HOST, {
    type: "ready.set",
    requestId: "ready-host",
    expectedRevision: nextRevision,
    ready: true
  });

  await flush();
  await flush();
  assert.equal(attempts.length, 1);
  assert.equal(runtime.snapshot.ready[0], false);

  nowMs = 2_100;
  await scheduler.run("commit-publish");
  await first;
  await second;

  assert.equal(attempts.length, 3);
  assert.strictEqual(attempts[0], attempts[1]);
  assert.equal(accepted.length, 2);
  assert.equal(runtime.snapshot.ready[0], true);
  assert.equal(errors.length, 1);
});

test("dispose wakes a commit retry and fences queued mutation", async () => {
  const scheduler = new ManualScheduler();
  let attempts = 0;
  const runtime = new RoomRuntime(lobbyActor(() => 2_000), {
    scheduler,
    now: () => 2_000,
    onCommit: () => {
      attempts += 1;
      throw new Error("permanent publish error");
    }
  });
  const first = runtime.dispatchUser(GUEST, {
    type: "member.join",
    requestId: "join-guest",
    participation: "player"
  });
  await waitUntil(() => scheduler.has("commit-publish"));
  const second = runtime.dispatchUser(HOST, {
    type: "ready.set",
    requestId: "ready-after-failure",
    expectedRevision: runtime.snapshot.revision,
    ready: true
  });

  runtime.dispose();
  await assert.rejects(first, /disposed/);
  await assert.rejects(second, /disposed/);
  assert.equal(attempts, 1);
  assert.equal(runtime.snapshot.ready[0], false);
  assert.equal(scheduler.tasks.size, 0);
});
