import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import type {
  ServerMessage
} from "../../../packages/protocol/src/messages.ts";
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
  ConnectionTransport
} from "../src/gateway/connectionHub.ts";
import {
  RealtimeService
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

  clear(): void {
    this.sent.length = 0;
  }
}

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
}

interface Fixture {
  readonly sessions: SessionStore;
  readonly connections: ConnectionHub;
  readonly rooms: RoomManager;
  readonly service: RealtimeService;
  readonly errors: unknown[];
}

function setup(
  t: TestContext,
  replayMatchStartForPlayer?: (playerId: string) => void
): Fixture {
  let tokenByte = 1;
  let sessionNumber = 0;
  let playerNumber = 0;
  let roomNumber = 0;
  const now = () => 1_000;
  const sessions = new SessionStore({
    hmacKey: Buffer.alloc(32, 0x5a),
    now,
    tokenFactory: () =>
      createResumeToken(() => Buffer.alloc(32, tokenByte++)),
    sessionIdFactory: () => `session-${++sessionNumber}`,
    playerIdFactory: () => `player-${++playerNumber}`
  });
  const connections = new ConnectionHub();
  const errors: unknown[] = [];
  const rooms = new RoomManager({
    now,
    registryOptions: {
      codeFactory: () => "ABC234",
      roomIdFactory: () => `room-${++roomNumber}`
    },
    schedulerFactory: () => new ManualScheduler(),
    onError: (error) => {
      errors.push(error);
    }
  });
  const service = new RealtimeService({
    sessions,
    connections,
    rooms,
    ...(replayMatchStartForPlayer === undefined
      ? {}
      : { replayMatchStartForPlayer }),
    onError: (error) => {
      errors.push(error);
    }
  });
  t.after(() => rooms.dispose());
  return { sessions, connections, rooms, service, errors };
}

function messagesOfType<Type extends ServerMessage["type"]>(
  transport: FakeTransport,
  type: Type
): Extract<ServerMessage, { readonly type: Type }>[] {
  return transport.sent
    .map((payload) => JSON.parse(payload) as ServerMessage)
    .filter(
      (message): message is Extract<ServerMessage, { readonly type: Type }> =>
        message.type === type
    );
}

function lastMessage<Type extends ServerMessage["type"]>(
  transport: FakeTransport,
  type: Type
): Extract<ServerMessage, { readonly type: Type }> {
  const messages = messagesOfType(transport, type);
  const message = messages.at(-1);
  assert.notEqual(message, undefined, `Missing ${type} message.`);
  return message!;
}

test("two guests create, join, ready and leave through real services", async (t) => {
  const fixture = setup(t);
  const aliceTransport = new FakeTransport();
  const bobTransport = new FakeTransport();
  const alice = fixture.service.createGuest(
    "connection-alice",
    aliceTransport,
    "Alice"
  );
  const bob = fixture.service.createGuest(
    "connection-bob",
    bobTransport,
    "Bob"
  );

  assert.notEqual(alice.resumeToken, bob.resumeToken);
  assert.equal(fixture.sessions.size, 2);
  assert.equal(fixture.connections.size, 2);

  await fixture.service.handleMessage(alice.context, {
    type: "room.create",
    requestId: "create-alice",
    settings: { targetWins: 3 }
  });
  const createOk = lastMessage(aliceTransport, "room.command.ok");
  const aliceInitial = lastMessage(aliceTransport, "room.state").state;
  const roomId = createOk.roomId;

  assert.equal(createOk.replayed, false);
  assert.equal(aliceInitial.self.playerId, alice.context.player.playerId);
  assert.equal(aliceInitial.self.seat, 0);
  assert.equal(aliceInitial.self.permissions.editSettings, true);
  assert.equal(aliceInitial.hostPlayerId, alice.context.player.playerId);
  assert.equal(JSON.stringify(aliceInitial).includes("connection-alice"), false);
  assert.equal(fixture.sessions.getBySessionId(alice.context.sessionId)?.roomId, roomId);

  await fixture.service.handleMessage(bob.context, {
    type: "room.join",
    requestId: "join-bob",
    roomCode: aliceInitial.roomCode,
    participation: "player",
    preferredSeat: 1
  });
  const bobState = lastMessage(bobTransport, "room.state").state;
  assert.equal(bobState.self.playerId, bob.context.player.playerId);
  assert.equal(bobState.self.seat, 1);
  assert.equal(bobState.self.permissions.editSettings, false);
  assert.equal(bobState.seats[0]?.playerId, alice.context.player.playerId);
  assert.equal(bobState.seats[1]?.playerId, bob.context.player.playerId);
  assert.equal(JSON.stringify(bobState).includes("connection-bob"), false);
  assert.equal(fixture.connections.roomSize(roomId), 2);

  let room = fixture.rooms.getById(roomId);
  assert.notEqual(room, null);
  await fixture.service.handleMessage(alice.context, {
    type: "room.ready.set",
    requestId: "ready-alice",
    roomId,
    expectedRevision: room!.state.revision,
    ready: true
  });
  const aliceReady = lastMessage(aliceTransport, "room.state").state;
  assert.equal(aliceReady.seats[0]?.ready, true);
  assert.equal(aliceReady.self.permissions.ready, true);

  room = fixture.rooms.getById(roomId);
  await fixture.service.handleMessage(bob.context, {
    type: "room.ready.set",
    requestId: "ready-bob",
    roomId,
    expectedRevision: room!.state.revision,
    ready: true
  });
  room = fixture.rooms.getById(roomId);
  assert.equal(room?.state.phase, "countdown");
  assert.deepEqual(room?.state.ready, [true, true]);

  await fixture.service.handleMessage(bob.context, {
    type: "room.leave",
    requestId: "leave-bob",
    roomId,
    expectedRevision: room!.state.revision
  });
  assert.equal(fixture.sessions.getBySessionId(bob.context.sessionId)?.roomId, null);
  assert.equal(fixture.connections.roomSize(roomId), 1);
  assert.equal(lastMessage(bobTransport, "room.removed").reason, "left");
  assert.equal(fixture.rooms.getById(roomId)?.state.seats[1], null);

  aliceTransport.clear();
  bobTransport.clear();
  fixture.connections.broadcastRoom(roomId, JSON.stringify({
    type: "pong",
    clientTime: 1,
    serverTime: 2
  }));
  assert.equal(aliceTransport.sent.length, 1);
  assert.equal(bobTransport.sent.length, 0);
  assert.deepEqual(fixture.errors, []);
});

test("resume rotates token and stale close cannot mark the member lost", async (t) => {
  const replayedPlayerIds: string[] = [];
  const fixture = setup(t, (playerId) => replayedPlayerIds.push(playerId));
  const oldTransport = new FakeTransport();
  const oldAuth = fixture.service.createGuest(
    "connection-old",
    oldTransport,
    "Alice"
  );
  await fixture.service.handleMessage(oldAuth.context, {
    type: "room.create",
    requestId: "create-room"
  });
  const roomId = lastMessage(oldTransport, "room.command.ok").roomId;
  const newTransport = new FakeTransport();

  const resumed = fixture.service.resumeGuest(
    "connection-new",
    newTransport,
    oldAuth.resumeToken
  );
  assert.notEqual(resumed, null);
  assert.notEqual(resumed!.resumeToken, oldAuth.resumeToken);
  assert.equal(resumed!.context.connectionGeneration, 1);
  assert.deepEqual(oldTransport.closes, [
    { code: 4001, reason: "superseded" }
  ]);
  assert.equal(
    fixture.service.resumeGuest(
      "connection-attacker",
      new FakeTransport(),
      oldAuth.resumeToken
    ),
    null
  );

  await fixture.service.afterAuthenticated(resumed!.context);
  let member = fixture.rooms
    .getById(roomId)
    ?.state.members[oldAuth.context.player.playerId];
  assert.equal(member?.connection.kind, "connected");
  if (member?.connection.kind === "connected") {
    assert.equal(member.connection.connectionId, "connection-new");
    assert.equal(member.connection.epoch, 1);
  }
  assert.equal(messagesOfType(newTransport, "room.state").length, 1);
  assert.deepEqual(replayedPlayerIds, [oldAuth.context.player.playerId]);

  await fixture.service.disconnect(oldAuth.context);
  member = fixture.rooms
    .getById(roomId)
    ?.state.members[oldAuth.context.player.playerId];
  assert.equal(member?.connection.kind, "connected");
  if (member?.connection.kind === "connected") {
    assert.equal(member.connection.connectionId, "connection-new");
  }
  assert.equal(fixture.service.isCurrent(resumed!.context), true);
  assert.equal(fixture.connections.isCurrent(resumed!.context), true);
  assert.deepEqual(fixture.errors, []);
});

test("missing rooms and revision conflicts return stable errors", async (t) => {
  const fixture = setup(t);
  const aliceTransport = new FakeTransport();
  const bobTransport = new FakeTransport();
  const alice = fixture.service.createGuest(
    "connection-alice",
    aliceTransport,
    "Alice"
  );
  const bob = fixture.service.createGuest(
    "connection-bob",
    bobTransport,
    "Bob"
  );

  await fixture.service.handleMessage(bob.context, {
    type: "room.join",
    requestId: "join-missing",
    roomCode: "ZZZ999",
    participation: "player"
  });
  const missingJoin = lastMessage(bobTransport, "error");
  assert.equal(missingJoin.code, "ROOM_NOT_FOUND");
  assert.equal(missingJoin.requestId, "join-missing");

  await fixture.service.handleMessage(alice.context, {
    type: "room.create",
    requestId: "create-room"
  });
  const roomId = lastMessage(aliceTransport, "room.command.ok").roomId;
  const currentRevision = fixture.rooms.getById(roomId)!.state.revision;
  await fixture.service.handleMessage(alice.context, {
    type: "room.ready.set",
    requestId: "stale-ready",
    roomId,
    expectedRevision: currentRevision + 10,
    ready: true
  });
  const conflict = lastMessage(aliceTransport, "error");
  assert.equal(conflict.code, "REVISION_CONFLICT");
  assert.equal(conflict.requestId, "stale-ready");
  assert.equal(conflict.currentRevision, currentRevision);
  assert.equal(conflict.retryable, true);
  assert.equal(fixture.rooms.getById(roomId)?.state.ready[0], false);

  assert.equal(fixture.rooms.remove(roomId), true);
  await fixture.service.handleMessage(alice.context, {
    type: "room.ready.set",
    requestId: "room-gone",
    roomId,
    expectedRevision: currentRevision,
    ready: true
  });
  const missingMutation = lastMessage(aliceTransport, "error");
  assert.equal(missingMutation.code, "ROOM_NOT_FOUND");
  assert.equal(missingMutation.requestId, "room-gone");
  assert.equal(fixture.sessions.getBySessionId(alice.context.sessionId)?.roomId, null);
  assert.equal(fixture.connections.roomSize(roomId), 0);
  assert.deepEqual(fixture.errors, []);
});
