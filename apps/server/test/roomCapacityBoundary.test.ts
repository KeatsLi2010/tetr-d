import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import type {
  ServerMessage
} from "../../../packages/protocol/src/messages.ts";
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
  RoomRuntimeCommit
} from "../src/rooms/roomRuntime.ts";

class FakeTransport implements ConnectionTransport {
  bufferedAmount = 0;
  readonly sent: string[] = [];

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {}

  clear(): void {
    this.sent.length = 0;
  }
}

class CommitGate {
  entries = 0;
  #blocked: Promise<void> | null = null;
  #release: (() => void) | null = null;

  block(): number {
    if (this.#blocked !== null) throw new Error("Gate is already blocked.");
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

type MessageOf<Type extends ServerMessage["type"]> = Extract<
  ServerMessage,
  { readonly type: Type }
>;

function messages<Type extends ServerMessage["type"]>(
  transport: FakeTransport,
  type: Type
): MessageOf<Type>[] {
  return transport.sent
    .map((payload) => JSON.parse(payload) as ServerMessage)
    .filter((message): message is MessageOf<Type> => message.type === type);
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

interface Fixture {
  readonly sessions: SessionStore;
  readonly connections: ConnectionHub;
  readonly rooms: RoomManager;
  readonly service: RealtimeService;
  readonly gate: CommitGate;
  readonly host: ReturnType<RealtimeService["createGuest"]>;
  readonly guest: ReturnType<RealtimeService["createGuest"]>;
  readonly hostTransport: FakeTransport;
  readonly guestTransport: FakeTransport;
  readonly roomId: string;
  readonly roomCode: string;
}

async function setup(
  t: TestContext,
  joinGuest: boolean
): Promise<Fixture> {
  let sessionNumber = 0;
  let playerNumber = 0;
  const sessions = new SessionStore({
    hmacKey: Buffer.alloc(32, 9),
    now: () => 2_000,
    sessionIdFactory: () => `session-${++sessionNumber}`,
    playerIdFactory: () => `player-${++playerNumber}`
  });
  const connections = new ConnectionHub();
  const gate = new CommitGate();
  const rooms = new RoomManager({
    now: () => 2_000,
    dispatchQueueCapacity: 1,
    registryOptions: {
      roomIdFactory: () => "capacity-room",
      codeFactory: () => "CAP234"
    },
    onCommit: (roomId, commit) => {
      assert.equal(roomId, "capacity-room");
      return gate.handle(commit);
    }
  });
  const service = new RealtimeService({
    sessions,
    connections,
    rooms
  });
  const hostTransport = new FakeTransport();
  const guestTransport = new FakeTransport();
  const host = service.createGuest(
    "connection-host",
    hostTransport,
    "Host"
  );
  const guest = service.createGuest(
    "connection-guest",
    guestTransport,
    "Guest"
  );
  await service.handleMessage(host.context, {
    type: "room.create",
    requestId: "create-room"
  });
  const roomState = messages(hostTransport, "room.state").at(-1)?.state;
  assert.notEqual(roomState, undefined);
  const roomId = roomState!.roomId;
  const roomCode = roomState!.roomCode;
  if (joinGuest) {
    await service.handleMessage(guest.context, {
      type: "room.join",
      requestId: "join-initial",
      roomCode,
      participation: "player"
    });
  }
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
    host,
    guest,
    hostTransport,
    guestTransport,
    roomId,
    roomCode
  };
}

function currentRevision(fixture: Fixture): number {
  return fixture.rooms.getById(fixture.roomId)!.state.revision;
}

async function blockWithHostMutation(
  fixture: Fixture,
  requestId: string,
  targetWins: 3 | 5
): Promise<{ readonly pending: Promise<void> }> {
  const expectedEntry = fixture.gate.block();
  const pending = fixture.service.handleMessage(fixture.host.context, {
    type: "room.settings.update",
    requestId,
    roomId: fixture.roomId,
    expectedRevision: currentRevision(fixture),
    patch: { targetWins }
  });
  await waitUntil(() => fixture.gate.entries >= expectedEntry);
  return { pending };
}

test("mutation and join capacity return retryable RATE_LIMITED", async (t) => {
  const fixture = await setup(t, false);
  const { pending: first } = await blockWithHostMutation(
    fixture,
    "blocking",
    5
  );
  fixture.hostTransport.clear();
  fixture.guestTransport.clear();

  const mutation = fixture.service.handleMessage(fixture.host.context, {
    type: "room.settings.update",
    requestId: "overflow-mutation",
    roomId: fixture.roomId,
    expectedRevision: currentRevision(fixture),
    patch: { targetWins: 3 }
  });
  const join = fixture.service.handleMessage(fixture.guest.context, {
    type: "room.join",
    requestId: "overflow-join",
    roomCode: fixture.roomCode,
    participation: "player"
  });
  await Promise.all([mutation, join]);

  const mutationError = messages(
    fixture.hostTransport,
    "error"
  ).at(-1);
  const joinError = messages(fixture.guestTransport, "error").at(-1);
  assert.deepEqual(
    [mutationError?.code, mutationError?.retryable, mutationError?.requestId],
    ["RATE_LIMITED", true, "overflow-mutation"]
  );
  assert.deepEqual(
    [joinError?.code, joinError?.retryable, joinError?.requestId],
    ["RATE_LIMITED", true, "overflow-join"]
  );
  assert.equal(
    fixture.sessions.getBySessionId(
      fixture.guest.context.sessionId
    )?.roomId,
    null
  );
  fixture.gate.release();
  await first;
});

test("lost and restore retry capacity without ghosting the member", async (t) => {
  const fixture = await setup(t, true);
  const { pending: first } = await blockWithHostMutation(
    fixture,
    "block-lost",
    5
  );
  const disconnected = fixture.service.disconnect(fixture.guest.context);
  let disconnectSettled = false;
  void disconnected.then(() => {
    disconnectSettled = true;
  });
  await flush();
  await flush();
  assert.equal(disconnectSettled, false);

  fixture.gate.release();
  await Promise.all([first, disconnected]);
  assert.equal(
    fixture.rooms.getById(fixture.roomId)?.state.members[
      fixture.guest.context.player.playerId
    ]?.connection.kind,
    "disconnected"
  );

  const resumedTransport = new FakeTransport();
  const resumed = fixture.service.resumeGuest(
    "connection-resumed",
    resumedTransport,
    fixture.guest.resumeToken
  );
  assert.notEqual(resumed, null);
  const { pending: second } = await blockWithHostMutation(
    fixture,
    "block-restore",
    3
  );
  const restored = fixture.service.afterAuthenticated(resumed!.context);
  let restoreSettled = false;
  void restored.then(
    () => {
      restoreSettled = true;
    },
    () => {
      restoreSettled = true;
    }
  );
  await flush();
  await flush();
  assert.equal(restoreSettled, false);

  fixture.gate.release();
  await Promise.all([second, restored]);
  const member = fixture.rooms.getById(fixture.roomId)?.state.members[
    fixture.guest.context.player.playerId
  ];
  assert.deepEqual(member?.connection, {
    kind: "connected",
    connectionId: "connection-resumed",
    epoch: 1
  });
  assert.equal(
    fixture.sessions.getBySessionId(resumed!.context.sessionId)?.roomId,
    fixture.roomId
  );
});

test("stale restore retry stops without clearing the room reservation", async (t) => {
  const fixture = await setup(t, true);
  await fixture.service.disconnect(fixture.guest.context);
  const firstTransport = new FakeTransport();
  const firstResume = fixture.service.resumeGuest(
    "connection-resume-one",
    firstTransport,
    fixture.guest.resumeToken
  );
  assert.notEqual(firstResume, null);
  const { pending: blocked } = await blockWithHostMutation(
    fixture,
    "block-stale-restore",
    5
  );
  const staleRestore = fixture.service.afterAuthenticated(
    firstResume!.context
  );
  const secondTransport = new FakeTransport();
  const secondResume = fixture.service.resumeGuest(
    "connection-resume-two",
    secondTransport,
    firstResume!.resumeToken
  );
  assert.notEqual(secondResume, null);
  await staleRestore;
  assert.equal(
    fixture.sessions.getBySessionId(
      secondResume!.context.sessionId
    )?.roomId,
    fixture.roomId
  );

  fixture.gate.release();
  await blocked;
  await fixture.service.afterAuthenticated(secondResume!.context);
  assert.equal(
    fixture.rooms.getById(fixture.roomId)?.state.members[
      fixture.guest.context.player.playerId
    ]?.connection.kind,
    "connected"
  );
});
