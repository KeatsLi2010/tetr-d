import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import {
  createResumeToken
} from "../src/auth/token.ts";
import {
  SessionStore
} from "../src/auth/sessionStore.ts";
import {
  ConnectionHub
} from "../src/gateway/connectionHub.ts";
import type {
  ConnectionIdentity,
  ConnectionTransport,
  GuardedMutationResult
} from "../src/gateway/connectionHub.ts";
import {
  RoomCreateReceiptLedger
} from "../src/gateway/roomCreateReceiptLedger.ts";
import {
  RoomMessageService
} from "../src/gateway/roomMessageService.ts";
import type {
  AuthenticatedConnection
} from "../src/gateway/realtimeService.ts";
import {
  RoomManager
} from "../src/rooms/roomManager.ts";
import type {
  RoomScheduler,
  RoomTaskCallback
} from "../src/rooms/roomScheduler.ts";

class FakeTransport implements ConnectionTransport {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: { readonly code: number; readonly reason: string }[] = [];

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
}

class ManualScheduler implements RoomScheduler {
  schedule(
    _key: string,
    _deadlineMs: number,
    _callback: RoomTaskCallback
  ): void {}
  cancel(_key: string): void {}
  cancelAll(): void {}
}

type BindFailure = "false" | "throw_after";

class FaultySessionStore extends SessionStore {
  nextBindFailure: BindFailure | null = null;

  override bindRoom(sessionId: string, roomId: string): boolean {
    const failure = this.nextBindFailure;
    this.nextBindFailure = null;
    if (failure === "false") return false;
    const bound = super.bindRoom(sessionId, roomId);
    if (failure === "throw_after") throw new Error("injected bind failure");
    return bound;
  }
}

type SetRoomFailure = "stale" | "not_found" | "throw_after";

class FaultyConnectionHub extends ConnectionHub {
  nextSetRoomFailure: SetRoomFailure | null = null;

  override setRoom(
    identity: ConnectionIdentity,
    roomId: string | null
  ): GuardedMutationResult {
    const failure = this.nextSetRoomFailure;
    this.nextSetRoomFailure = null;
    if (failure === "stale") return { status: "stale" };
    if (failure === "not_found") return { status: "not_found" };
    const result = super.setRoom(identity, roomId);
    if (failure === "throw_after") {
      throw new Error("injected connection binding failure");
    }
    return result;
  }
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class ControlledRoomManager extends RoomManager {
  createCalls = 0;
  joinGate: Promise<void> | null = null;
  nextJoinError: Error | null = null;

  override create(...args: Parameters<RoomManager["create"]>) {
    this.createCalls += 1;
    return super.create(...args);
  }

  override async joinByCode(
    ...args: Parameters<RoomManager["joinByCode"]>
  ) {
    if (this.joinGate !== null) await this.joinGate;
    const error = this.nextJoinError;
    this.nextJoinError = null;
    if (error !== null) throw error;
    return super.joinByCode(...args);
  }
}

interface Fixture {
  readonly sessions: FaultySessionStore;
  readonly connections: FaultyConnectionHub;
  readonly rooms: ControlledRoomManager;
  readonly receipts: RoomCreateReceiptLedger;
  readonly service: RoomMessageService;
  readonly errors: unknown[];
}

function setup(t: TestContext): Fixture {
  let tokenByte = 1;
  let sessionNumber = 0;
  let playerNumber = 0;
  let roomNumber = 0;
  const sessions = new FaultySessionStore({
    hmacKey: Buffer.alloc(32, 0x61),
    now: () => 1_000,
    tokenFactory: () =>
      createResumeToken(() => Buffer.alloc(32, tokenByte++)),
    sessionIdFactory: () => `session-${++sessionNumber}`,
    playerIdFactory: () => `player-${++playerNumber}`
  });
  const connections = new FaultyConnectionHub();
  const errors: unknown[] = [];
  const rooms = new ControlledRoomManager({
    now: () => 1_000,
    registryOptions: {
      codeFactory: () => "ABC234",
      roomIdFactory: () => `room-${++roomNumber}`
    },
    schedulerFactory: () => new ManualScheduler(),
    onError: (error) => errors.push(error)
  });
  const receipts = new RoomCreateReceiptLedger({ now: () => 1_000 });
  const service = new RoomMessageService({
    sessions,
    connections,
    rooms,
    createReceipts: receipts,
    onError: (error) => errors.push(error)
  });
  t.after(() => rooms.dispose());
  return { sessions, connections, rooms, receipts, service, errors };
}

interface Guest {
  readonly context: AuthenticatedConnection;
  readonly resumeToken: string;
  readonly transport: FakeTransport;
}

function addGuest(fixture: Fixture, name: string, connectionId: string): Guest {
  const transport = new FakeTransport();
  const issued = fixture.sessions.createGuest({
    displayName: name,
    connectionId
  });
  const context: AuthenticatedConnection = Object.freeze({
    sessionId: issued.session.sessionId,
    connectionId,
    connectionGeneration: issued.session.connectionGeneration,
    player: Object.freeze({
      playerId: issued.session.playerId,
      displayName: issued.session.displayName
    })
  });
  fixture.connections.bind({ ...context, roomId: null, transport });
  return { context, resumeToken: issued.resumeToken, transport };
}

function messages(guest: Guest): Record<string, unknown>[] {
  return guest.transport.sent.map(
    (payload) => JSON.parse(payload) as Record<string, unknown>
  );
}

function createJoinTarget(fixture: Fixture) {
  return fixture.rooms.create({
    principal: {
      sessionId: "host-session",
      connectionId: "host-connection",
      connectionGeneration: 0,
      player: { playerId: "host-player", displayName: "Host" }
    }
  });
}

test("create replays canonical payload and rejects request reuse", async (t) => {
  const fixture = setup(t);
  const guest = addGuest(fixture, "Alice", "connection-a");
  await fixture.service.handle(guest.context, {
    type: "room.create",
    requestId: "create-1",
    roomCode: "def567",
    settings: { targetWins: 3, allowSpectators: false }
  });
  const firstOk = messages(guest).find((message) =>
    message.type === "room.command.ok"
  );
  assert.equal(firstOk?.replayed, false);
  assert.equal(fixture.rooms.createCalls, 1);
  assert.equal(
    fixture.rooms.getById(String(firstOk?.roomId))?.state.roomCode,
    "DEF567"
  );

  guest.transport.sent.length = 0;
  await fixture.service.handle(guest.context, {
    type: "room.create",
    requestId: "create-1",
    roomCode: "DEF567",
    settings: { allowSpectators: false, targetWins: 3 }
  });
  assert.deepEqual(
    messages(guest).find((message) => message.type === "room.command.ok"),
    { ...firstOk, replayed: true }
  );
  assert.equal(fixture.rooms.createCalls, 1);

  await fixture.service.handle(guest.context, {
    type: "room.create",
    requestId: "create-1",
    roomCode: "DEF567",
    settings: { targetWins: 5, allowSpectators: false }
  });
  assert.equal(messages(guest).at(-1)?.code, "REQUEST_ID_REUSED");
  assert.equal(fixture.rooms.size, 1);
});

test("create rolls back bind and connection failures exactly", async (t) => {
  const cases = [
    { bind: "false" as const, setRoom: null },
    { bind: "throw_after" as const, setRoom: null },
    { bind: null, setRoom: "stale" as const },
    { bind: null, setRoom: "not_found" as const },
    { bind: null, setRoom: "throw_after" as const }
  ];
  for (const [index, failure] of cases.entries()) {
    await t.test(`failure ${index + 1}`, async (child) => {
      const fixture = setup(child);
      const guest = addGuest(fixture, "Alice", `connection-${index}`);
      fixture.sessions.nextBindFailure = failure.bind;
      fixture.connections.nextSetRoomFailure = failure.setRoom;
      await fixture.service.handle(guest.context, {
        type: "room.create",
        requestId: "create-rollback"
      });
      assert.equal(fixture.rooms.size, 0);
      assert.equal(
        fixture.sessions.getBySessionId(guest.context.sessionId)?.roomId,
        null
      );
      assert.equal(fixture.connections.roomSize("room-1"), 0);
      assert.equal(fixture.receipts.size, 0);
      assert.equal(messages(guest).at(-1)?.code, "MESSAGE_INVALID");

      await fixture.service.handle(guest.context, {
        type: "room.create",
        requestId: "create-rollback"
      });
      assert.equal(fixture.rooms.size, 1);
      assert.equal(fixture.receipts.size, 1);
    });
  }
});

test("join throw clears only a reservation made by this request", async (t) => {
  const fixture = setup(t);
  const room = createJoinTarget(fixture);
  const fresh = addGuest(fixture, "Fresh", "connection-fresh");
  fixture.rooms.nextJoinError = new Error("injected join failure");
  await fixture.service.handle(fresh.context, {
    type: "room.join",
    requestId: "join-fresh",
    roomCode: room.roomCode,
    participation: "player"
  });
  assert.equal(
    fixture.sessions.getBySessionId(fresh.context.sessionId)?.roomId,
    null
  );

  const existing = addGuest(fixture, "Existing", "connection-existing");
  fixture.sessions.bindRoom(existing.context.sessionId, room.roomId);
  fixture.connections.setRoom(existing.context, room.roomId);
  fixture.rooms.nextJoinError = new Error("injected retry failure");
  await fixture.service.handle(existing.context, {
    type: "room.join",
    requestId: "join-existing",
    roomCode: room.roomCode,
    participation: "player"
  });
  assert.equal(
    fixture.sessions.getBySessionId(existing.context.sessionId)?.roomId,
    room.roomId
  );
});

test("committed join restores a connection resumed during dispatch", async (t) => {
  const fixture = setup(t);
  const room = createJoinTarget(fixture);
  const old = addGuest(fixture, "Alice", "connection-old");
  const gate = deferred();
  fixture.rooms.joinGate = gate.promise;
  const pending = fixture.service.handle(old.context, {
    type: "room.join",
    requestId: "join-race",
    roomCode: room.roomCode,
    participation: "player"
  });
  assert.equal(
    fixture.sessions.getBySessionId(old.context.sessionId)?.roomId,
    room.roomId
  );
  const resumed = fixture.sessions.resume({
    resumeToken: old.resumeToken,
    newConnectionId: "connection-new"
  });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  fixture.connections.bind({
    sessionId: resumed.session.sessionId,
    connectionId: "connection-new",
    connectionGeneration: resumed.session.connectionGeneration,
    roomId: resumed.session.roomId,
    transport: new FakeTransport()
  });
  gate.resolve();
  await pending;

  const member = fixture.rooms
    .getById(room.roomId)
    ?.state.members[old.context.player.playerId];
  assert.equal(member?.connection.kind, "connected");
  if (member?.connection.kind === "connected") {
    assert.equal(member.connection.connectionId, "connection-new");
  }
  assert.equal(fixture.connections.roomSize(room.roomId), 1);
  assert.deepEqual(fixture.errors, []);
});

test("committed join marks an unavailable connection as lost", async (t) => {
  const fixture = setup(t);
  const room = createJoinTarget(fixture);
  const guest = addGuest(fixture, "Alice", "connection-old");
  const gate = deferred();
  fixture.rooms.joinGate = gate.promise;
  const pending = fixture.service.handle(guest.context, {
    type: "room.join",
    requestId: "join-disconnect",
    roomCode: room.roomCode,
    participation: "player"
  });
  fixture.sessions.releaseConnection(
    guest.context.sessionId,
    guest.context.connectionId,
    guest.context.connectionGeneration
  );
  fixture.connections.unbind(guest.context);
  gate.resolve();
  await pending;

  const member = fixture.rooms
    .getById(room.roomId)
    ?.state.members[guest.context.player.playerId];
  assert.equal(member?.connection.kind, "disconnected");
  assert.deepEqual(fixture.errors, []);
});
