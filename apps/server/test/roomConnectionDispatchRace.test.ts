import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import { SessionStore } from "../src/auth/sessionStore.ts";
import {
  ConnectionHub
} from "../src/gateway/connectionHub.ts";
import type {
  ConnectionTransport
} from "../src/gateway/connectionHub.ts";
import {
  RealtimeService
} from "../src/gateway/realtimeService.ts";
import {
  RoomManager
} from "../src/rooms/roomManager.ts";
import type {
  RoomRuntimeCommit
} from "../src/rooms/roomRuntime.ts";
import type {
  RoomScheduler,
  RoomTaskCallback
} from "../src/rooms/roomScheduler.ts";

class FakeTransport implements ConnectionTransport {
  bufferedAmount = 0;
  send(): void {}
  close(): void {}
}

class NoopScheduler implements RoomScheduler {
  schedule(
    _key: string,
    _deadlineMs: number,
    _callback: RoomTaskCallback
  ): void {}
  cancel(): void {}
  cancelAll(): void {}
}

class CommitGate {
  entries = 0;
  #blocked: Promise<void> | null = null;
  #release: (() => void) | null = null;

  block(): number {
    assert.equal(this.#blocked, null);
    this.#blocked = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    return this.entries + 1;
  }

  async handle(_commit: RoomRuntimeCommit): Promise<void> {
    this.entries += 1;
    if (this.#blocked !== null) await this.#blocked;
  }

  release(): void {
    const release = this.#release;
    this.#release = null;
    this.#blocked = null;
    release?.();
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("Condition was not reached.");
}

async function setup(t: TestContext) {
  let nowMs = 2_000;
  let sessionNumber = 0;
  let playerNumber = 0;
  const sessions = new SessionStore({
    hmacKey: Buffer.alloc(32, 11),
    now: () => nowMs,
    sessionIdFactory: () => `session-${++sessionNumber}`,
    playerIdFactory: () => `player-${++playerNumber}`
  });
  const connections = new ConnectionHub();
  const gate = new CommitGate();
  const errors: unknown[] = [];
  const rooms = new RoomManager({
    now: () => nowMs,
    registryOptions: {
      roomIdFactory: () => "race-room",
      codeFactory: () => "RAC234"
    },
    schedulerFactory: () => new NoopScheduler(),
    onCommit: (_roomId, commit) => gate.handle(commit),
    onError: (error) => errors.push(error)
  });
  const service = new RealtimeService({
    sessions,
    connections,
    rooms,
    onError: (error) => errors.push(error)
  });
  const host = service.createGuest(
    "connection-host",
    new FakeTransport(),
    "Host"
  );
  const guest = service.createGuest(
    "connection-guest",
    new FakeTransport(),
    "Guest"
  );
  await service.handleMessage(host.context, {
    type: "room.create",
    requestId: "create"
  });
  await service.handleMessage(guest.context, {
    type: "room.join",
    requestId: "join",
    roomCode: "RAC234",
    participation: "player"
  });
  t.after(() => {
    gate.release();
    rooms.dispose();
  });
  return {
    sessions,
    connections,
    rooms,
    service,
    gate,
    errors,
    host,
    guest,
    roomId: "race-room",
    setNow(value: number) {
      nowMs = value;
    }
  };
}

async function blockHostMutation(
  fixture: Awaited<ReturnType<typeof setup>>,
  requestId: string
): Promise<void> {
  const expectedEntry = fixture.gate.block();
  const revision = fixture.rooms.getById(fixture.roomId)!.state.revision;
  const pending = fixture.service.handleMessage(fixture.host.context, {
    type: "room.settings.update",
    requestId,
    roomId: fixture.roomId,
    expectedRevision: revision,
    patch: { targetWins: 5 }
  });
  await waitUntil(() => fixture.gate.entries >= expectedEntry);
  return pending;
}

test("ignored restore rebuilds from state after queued lost", async (t) => {
  const fixture = await setup(t);
  const blocked = blockHostMutation(fixture, "block-race");
  await waitUntil(() => fixture.gate.entries >= 2);

  const disconnected = fixture.service.disconnect(fixture.guest.context);
  const resumed = fixture.service.resumeGuest(
    "connection-resumed",
    new FakeTransport(),
    fixture.guest.resumeToken
  );
  assert.notEqual(resumed, null);
  const restored = fixture.service.afterAuthenticated(resumed!.context);

  fixture.gate.release();
  await Promise.all([blocked, disconnected, restored]);

  const member = fixture.rooms.getById(fixture.roomId)?.state.members[
    fixture.guest.context.player.playerId
  ];
  assert.equal(member?.connection.kind, "connected");
  if (member?.connection.kind === "connected") {
    assert.equal(member.connection.connectionId, "connection-resumed");
  }
  assert.deepEqual(fixture.errors, []);
});

test("stale rejected restore cannot clear the newer room binding", async (t) => {
  const fixture = await setup(t);
  await fixture.service.disconnect(fixture.guest.context);
  const firstResume = fixture.service.resumeGuest(
    "connection-resume-one",
    new FakeTransport(),
    fixture.guest.resumeToken
  );
  assert.notEqual(firstResume, null);

  const blocked = blockHostMutation(fixture, "block-expired");
  await waitUntil(() => fixture.gate.entries >= 3);
  const staleRestore = fixture.service.afterAuthenticated(
    firstResume!.context
  );
  const secondResume = fixture.service.resumeGuest(
    "connection-resume-two",
    new FakeTransport(),
    firstResume!.resumeToken
  );
  assert.notEqual(secondResume, null);
  const member = fixture.rooms.getById(fixture.roomId)?.state.members[
    fixture.guest.context.player.playerId
  ];
  assert.equal(member?.connection.kind, "disconnected");
  if (member?.connection.kind === "disconnected") {
    fixture.setNow(member.connection.reconnectDeadlineMs);
  }

  fixture.gate.release();
  await Promise.all([blocked, staleRestore]);

  assert.equal(
    fixture.sessions.getBySessionId(secondResume!.context.sessionId)?.roomId,
    fixture.roomId
  );
  assert.equal(fixture.connections.roomSize(fixture.roomId), 2);
  assert.deepEqual(fixture.errors, []);
});
