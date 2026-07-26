import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import WebSocket from "ws";

import {
  PROTOCOL_VERSION
} from "../../../packages/protocol/src/messages.ts";
import type {
  ClientMessage,
  ServerMessage
} from "../../../packages/protocol/src/messages.ts";
import { createTetrServer } from "../src/serverApp.ts";
import {
  GatewayConnection
} from "../src/gateway/gatewayConnection.ts";
import type {
  ConnectionTransport
} from "../src/gateway/connectionHub.ts";
import { ConnectionRateLimiter } from "../src/gateway/rateLimiter.ts";
import type {
  AuthenticatedConnection,
  AuthenticationSuccess,
  RealtimeService
} from "../src/gateway/realtimeService.ts";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: { readonly code: number; readonly reason: string }[] = [];

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
  }

  ping(): void {}

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
  }

  receive(message: ClientMessage): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }

  messages(): ServerMessage[] {
    return this.sent.map((payload) => JSON.parse(payload) as ServerMessage);
  }
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface HarnessOptions {
  readonly maxPendingMessages: number;
  readonly afterAuthenticated?: (
    context: AuthenticatedConnection
  ) => Promise<void>;
  readonly handleMessage?: () => Promise<void>;
}

interface Harness {
  readonly socket: FakeSocket;
  readonly connection: GatewayConnection;
  readonly errors: unknown[];
}

function createHarness(options: HarnessOptions): Harness {
  const socket = new FakeSocket();
  const errors: unknown[] = [];
  const service = {
    createGuest(
      connectionId: string,
      _transport: ConnectionTransport,
      displayName: string
    ): AuthenticationSuccess {
      return {
        context: {
          sessionId: "session-1",
          connectionId,
          connectionGeneration: 0,
          player: { playerId: "player-1", displayName }
        },
        resumeToken: `rt1.${"A".repeat(43)}`
      };
    },
    resumeGuest(): null {
      return null;
    },
    async afterAuthenticated(
      context: AuthenticatedConnection
    ): Promise<void> {
      await options.afterAuthenticated?.(context);
    },
    async handleMessage(): Promise<void> {
      await options.handleMessage?.();
    },
    async disconnect(): Promise<void> {}
  } as unknown as RealtimeService;
  const connection = new GatewayConnection({
    socket: socket as unknown as WebSocket,
    connectionId: "connection-1",
    service,
    rateLimiter: new ConnectionRateLimiter(),
    heartbeatMs: 10_000,
    helloTimeoutMs: 1_000,
    authTimeoutMs: 1_000,
    maxInvalidMessages: 3,
    maxPendingMessages: options.maxPendingMessages,
    onClose: () => undefined,
    onError: (error) => errors.push(error)
  });
  return { socket, connection, errors };
}

function hello(): ClientMessage {
  return {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    buildId: "test"
  };
}

async function drainQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("capacity counts running and queued messages then closes with 1008", async (t) => {
  const started = deferred();
  const release = deferred();
  const harness = createHarness({
    maxPendingMessages: 2,
    afterAuthenticated: async () => {
      started.resolve();
      await release.promise;
    }
  });
  t.after(() => harness.connection.dispose());

  harness.socket.receive(hello());
  await drainQueue();
  harness.socket.receive({ type: "auth.guest", displayName: "Alice" });
  await started.promise;
  assert.equal(harness.connection.pendingMessageCount, 1);

  harness.socket.receive({ type: "ping", clientTime: 1 });
  assert.equal(harness.connection.pendingMessageCount, 2);
  harness.socket.receive({ type: "ping", clientTime: 2 });

  assert.deepEqual(harness.socket.closes, [
    { code: 1008, reason: "message queue capacity" }
  ]);
  assert.equal(
    harness.socket.closes.some(({ code }) => code === 1011),
    false
  );

  release.resolve();
  await drainQueue();
  assert.equal(harness.connection.pendingMessageCount, 0);
  assert.equal(
    harness.socket.messages().some(({ type }) => type === "pong"),
    false
  );
  harness.socket.receive({ type: "ping", clientTime: 3 });
  assert.equal(harness.connection.pendingMessageCount, 0);
  assert.deepEqual(harness.errors, []);
});

test("successful and failed handlers both release message capacity", async (t) => {
  const success = createHarness({ maxPendingMessages: 1 });
  t.after(() => success.connection.dispose());
  success.socket.receive(hello());
  assert.equal(success.connection.pendingMessageCount, 1);
  await drainQueue();
  assert.equal(success.connection.pendingMessageCount, 0);
  success.socket.receive({ type: "auth.guest", displayName: "Alice" });
  await drainQueue();
  assert.equal(success.connection.pendingMessageCount, 0);
  assert.deepEqual(success.socket.closes, []);

  const failure = createHarness({
    maxPendingMessages: 1,
    handleMessage: async () => {
      throw new Error("injected handler failure");
    }
  });
  t.after(() => failure.connection.dispose());
  failure.socket.receive(hello());
  await drainQueue();
  failure.socket.receive({ type: "auth.guest", displayName: "Bob" });
  await drainQueue();
  failure.socket.receive({ type: "room.create", requestId: "create-1" });
  await drainQueue();
  assert.equal(failure.connection.pendingMessageCount, 0);
  assert.deepEqual(failure.socket.closes, [
    { code: 1011, reason: "gateway error" }
  ]);
  assert.equal(failure.errors.length, 1);
});

test("dispose fences queued and future messages while counters drain", async () => {
  const started = deferred();
  const release = deferred();
  const harness = createHarness({
    maxPendingMessages: 2,
    afterAuthenticated: async () => {
      started.resolve();
      await release.promise;
    }
  });

  harness.socket.receive(hello());
  await drainQueue();
  harness.socket.receive({ type: "auth.guest", displayName: "Alice" });
  await started.promise;
  harness.socket.receive({ type: "ping", clientTime: 1 });
  assert.equal(harness.connection.pendingMessageCount, 2);

  harness.connection.dispose();
  harness.socket.receive({ type: "ping", clientTime: 2 });
  assert.equal(harness.connection.pendingMessageCount, 2);
  release.resolve();
  await drainQueue();
  assert.equal(harness.connection.pendingMessageCount, 0);
  assert.equal(
    harness.socket.messages().some(({ type }) => type === "pong"),
    false
  );
});

test("queue capacity is validated through the server options", () => {
  assert.throws(
    () => createTetrServer({
      allowUnsafeDevelopmentAccess: true,
      maxPendingMessages: 0
    }),
    /Invalid message queue capacity/
  );
});
