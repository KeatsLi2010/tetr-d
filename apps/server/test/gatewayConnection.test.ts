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
import { GatewayConnection } from "../src/gateway/gatewayConnection.ts";
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
  terminated = false;

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
  }

  ping(): void {}

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }

  receive(message: ClientMessage): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }

  messages(): ServerMessage[] {
    return this.sent.map((payload) => JSON.parse(payload) as ServerMessage);
  }
}

interface Harness {
  readonly socket: FakeSocket;
  readonly connection: GatewayConnection;
  readonly guestCreations: () => number;
}

function createHarness(authTimeoutMs: number): Harness {
  const socket = new FakeSocket();
  let guestCreations = 0;
  const service = {
    createGuest(
      connectionId: string,
      _transport: ConnectionTransport,
      displayName: string
    ): AuthenticationSuccess {
      guestCreations += 1;
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
      _context: AuthenticatedConnection
    ): Promise<void> {},
    async handleMessage(): Promise<void> {},
    async disconnect(): Promise<void> {}
  } as unknown as RealtimeService;
  const connection = new GatewayConnection({
    socket: socket as unknown as WebSocket,
    connectionId: "connection-1",
    service,
    rateLimiter: new ConnectionRateLimiter(),
    heartbeatMs: 10_000,
    helloTimeoutMs: 1_000,
    authTimeoutMs,
    maxInvalidMessages: 3,
    onClose: () => undefined
  });
  return {
    socket,
    connection,
    guestCreations: () => guestCreations
  };
}

async function drainQueue(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("protocol close fences already queued messages", async (t) => {
  const harness = createHarness(500);
  t.after(() => harness.connection.dispose());

  harness.socket.receive({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION + 1,
    buildId: "test"
  });
  harness.socket.receive({ type: "auth.guest", displayName: "Alice" });
  await drainQueue();

  assert.equal(harness.guestCreations(), 0);
  assert.deepEqual(harness.socket.closes, [
    { code: 1002, reason: "protocol mismatch" }
  ]);
  const errors = harness.socket
    .messages()
    .filter((message) => message.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, "PROTOCOL_MISMATCH");
});

test("hello starts an independent guest authentication deadline", async (t) => {
  const harness = createHarness(15);
  t.after(() => harness.connection.dispose());

  harness.socket.receive({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    buildId: "test"
  });
  await drainQueue();
  assert.equal(harness.socket.messages()[0]?.type, "welcome");

  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(harness.socket.closes, [
    { code: 1008, reason: "authentication timeout" }
  ]);
  const timeout = harness.socket
    .messages()
    .find(
      (message): message is Extract<ServerMessage, { readonly type: "error" }> =>
        message.type === "error" && message.code === "AUTH_REQUIRED"
    );
  assert.equal(timeout?.retryable, false);

  harness.socket.receive({ type: "auth.guest", displayName: "Too Late" });
  await drainQueue();
  assert.equal(harness.guestCreations(), 0);
});
