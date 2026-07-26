import assert from "node:assert/strict";
import test from "node:test";

import type { RoomActorPrincipal } from "../src/roomActor.ts";
import { RoomManager } from "../src/rooms/roomManager.ts";
import type { RoomRuntimeCommit } from "../src/rooms/roomRuntime.ts";
import type {
  RoomScheduler,
  RoomTaskCallback
} from "../src/rooms/roomScheduler.ts";

class ManualScheduler implements RoomScheduler {
  readonly tasks = new Map<
    string,
    { readonly deadlineMs: number; readonly callback: RoomTaskCallback }
  >();
  cancelAllCalls = 0;

  schedule(
    key: string,
    deadlineMs: number,
    callback: RoomTaskCallback
  ): void {
    const existing = this.tasks.get(key);
    if (existing?.deadlineMs === deadlineMs) return;
    this.tasks.set(key, { deadlineMs, callback });
  }

  cancel(key: string): void {
    this.tasks.delete(key);
  }

  cancelAll(): void {
    this.cancelAllCalls += 1;
    this.tasks.clear();
  }
}

const HOST_ONE: RoomActorPrincipal = {
  sessionId: "session-host-one",
  player: { playerId: "host-one", displayName: "Host One" },
  connectionId: "connection-host-one",
  connectionGeneration: 0
};
const HOST_TWO: RoomActorPrincipal = {
  sessionId: "session-host-two",
  player: { playerId: "host-two", displayName: "Host Two" },
  connectionId: "connection-host-two",
  connectionGeneration: 0
};
const GUEST: RoomActorPrincipal = {
  sessionId: "session-guest",
  player: { playerId: "guest", displayName: "Guest" },
  connectionId: "connection-guest",
  connectionGeneration: 0
};

interface ManagerContext {
  readonly manager: RoomManager;
  readonly scheduler: ManualScheduler;
  readonly commits: {
    readonly roomId: string;
    readonly commit: RoomRuntimeCommit;
  }[];
  setNow(value: number): void;
}

function setup(): ManagerContext {
  let nowMs = 1_000;
  let roomNumber = 0;
  const roomCodes = ["AAA234", "BBB345", "CCC456"];
  const scheduler = new ManualScheduler();
  const commits: ManagerContext["commits"][number][] = [];
  const manager = new RoomManager({
    now: () => nowMs,
    registryOptions: {
      roomIdFactory: () => `room-${++roomNumber}`,
      codeFactory: () => roomCodes.shift() ?? "DDD567"
    },
    schedulerFactory: () => scheduler,
    matchIdFactory: () => "match-manager",
    onCommit: (roomId, commit) => {
      commits.push({ roomId, commit });
    }
  });
  return {
    manager,
    scheduler,
    commits,
    setNow(value) {
      nowMs = value;
    }
  };
}

async function required<T>(value: Promise<T> | null): Promise<T> {
  if (value === null) throw new Error("Expected a managed room result.");
  return value;
}

test("create, code lookup, join and user dispatch share one runtime", async () => {
  const context = setup();
  const created = context.manager.create({
    principal: HOST_ONE,
    settings: { targetWins: 2 }
  });

  assert.equal(created.roomId, "room-1");
  assert.equal(created.roomCode, "AAA234");
  assert.equal(created.state.hostPlayerId, "host-one");
  assert.deepEqual(created.state.seats, ["host-one", null]);
  assert.equal(context.manager.size, 1);
  assert.equal(context.manager.getById("room-1")?.state.revision, 1);
  assert.equal(context.manager.getByCode("aaa234")?.roomId, "room-1");

  const joined = await context.manager.joinByCode(GUEST, "aaa234", {
    type: "member.join",
    requestId: "join-guest",
    participation: "player"
  });
  assert.notEqual(joined, null);
  assert.equal(joined?.receipt.kind, "committed");
  assert.deepEqual(
    context.manager.getById("room-1")?.state.seats,
    ["host-one", "guest"]
  );

  context.setNow(1_250);
  const updated = await required(
    context.manager.dispatchUser("room-1", HOST_ONE, {
      type: "settings.update",
      requestId: "settings-host",
      expectedRevision: joined!.state.revision,
      patch: { targetWins: 5 }
    })
  );
  assert.equal(updated.receipt.kind, "committed");
  assert.equal(
    context.manager.getById("room-1")?.state.settings.targetWins,
    5
  );
  assert.equal(updated.state.updatedAtMs, 1_250);
});

test("missing rooms return null and removal clears registry and timers", async () => {
  const context = setup();
  assert.equal(context.manager.getById("missing"), null);
  assert.equal(context.manager.getByCode("ZZZ999"), null);
  assert.equal(
    await context.manager.joinByCode(GUEST, "ZZZ999", {
      type: "member.join",
      requestId: "join-missing",
      participation: "player"
    }),
    null
  );
  assert.equal(
    context.manager.dispatchUser("missing", HOST_ONE, {
      type: "room.close",
      requestId: "close-missing",
      expectedRevision: 1
    }),
    null
  );
  assert.equal(context.manager.dispatchSystem("missing", {
    type: "admin.close",
    reason: "server_shutdown"
  }), null);
  assert.equal(context.manager.connectionLost(
    "missing",
    "host-one",
    "connection-host-one"
  ), null);
  assert.equal(context.manager.restoreConnection(
    "missing",
    "host-one",
    "connection-new"
  ), null);
  assert.equal(context.manager.remove("missing"), false);

  const room = context.manager.create({ principal: HOST_ONE });
  assert.equal(context.scheduler.tasks.size, 1);
  assert.equal(context.manager.remove(room.roomId), true);
  assert.equal(context.manager.getById(room.roomId), null);
  assert.equal(context.manager.size, 0);
  assert.equal(context.scheduler.tasks.size, 0);
});

test("lost, resumed and replaced connections use current epochs", async () => {
  const context = setup();
  const room = context.manager.create({ principal: HOST_ONE });

  assert.equal(context.manager.restoreConnection(
    room.roomId,
    "host-one",
    "connection-host-one"
  ), null);
  const replaced = await required(context.manager.restoreConnection(
    room.roomId,
    "host-one",
    "connection-replaced"
  ));
  assert.equal(replaced.receipt.kind, "committed");
  assert.deepEqual(replaced.state.members["host-one"]?.connection, {
    kind: "connected",
    connectionId: "connection-replaced",
    epoch: 1
  });

  assert.equal(context.manager.connectionLost(
    room.roomId,
    "host-one",
    "connection-host-one"
  ), null);
  const lost = await required(context.manager.connectionLost(
    room.roomId,
    "host-one",
    "connection-replaced"
  ));
  assert.equal(lost.receipt.kind, "committed");
  assert.equal(lost.state.members["host-one"]?.connection.kind, "disconnected");

  const resumed = await required(context.manager.restoreConnection(
    room.roomId,
    "host-one",
    "connection-resumed"
  ));
  assert.equal(resumed.receipt.kind, "committed");
  assert.deepEqual(resumed.state.members["host-one"]?.connection, {
    kind: "connected",
    connectionId: "connection-resumed",
    epoch: 2
  });
});

test("a replay does not invoke onCommit or expose effects twice", async () => {
  const context = setup();
  const room = context.manager.create({ principal: HOST_ONE });
  const command = {
    type: "settings.update",
    requestId: "settings-once",
    expectedRevision: room.state.revision,
    patch: { targetWins: 5 }
  } as const;

  const first = await required(
    context.manager.dispatchUser(room.roomId, HOST_ONE, command)
  );
  const commitCount = context.commits.length;
  const replay = await required(
    context.manager.dispatchUser(room.roomId, HOST_ONE, command)
  );

  assert.equal(first.replayed, false);
  assert.equal(commitCount, 1);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.effects, []);
  assert.equal(context.commits.length, commitCount);
  assert.equal(context.commits[0]?.roomId, room.roomId);
});

test("shared scheduler keys are isolated and removal is room-scoped", () => {
  const context = setup();
  const first = context.manager.create({ principal: HOST_ONE });
  const second = context.manager.create({ principal: HOST_TWO });

  assert.deepEqual(
    [...context.scheduler.tasks.keys()].sort(),
    [
      `room:${first.roomId}:room-expiry`,
      `room:${second.roomId}:room-expiry`
    ]
  );

  assert.equal(context.manager.remove(first.roomId), true);
  assert.deepEqual(
    [...context.scheduler.tasks.keys()],
    [`room:${second.roomId}:room-expiry`]
  );
  assert.equal(context.manager.getById(second.roomId)?.roomId, second.roomId);
  assert.equal(context.scheduler.cancelAllCalls, 0);
});

test("dispose is idempotent, clears owned tasks and rejects new rooms", () => {
  const context = setup();
  context.manager.create({ principal: HOST_ONE });
  context.manager.create({ principal: HOST_TWO });
  assert.equal(context.scheduler.tasks.size, 2);

  context.manager.dispose();
  context.manager.dispose();

  assert.equal(context.manager.size, 0);
  assert.equal(context.scheduler.tasks.size, 0);
  assert.equal(context.scheduler.cancelAllCalls, 0);
  assert.throws(
    () => context.manager.create({ principal: GUEST }),
    /disposed/
  );
  assert.throws(() => context.manager.getById("room-1"), /disposed/);
});
