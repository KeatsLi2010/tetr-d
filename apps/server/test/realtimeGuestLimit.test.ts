import assert from "node:assert/strict";
import test from "node:test";

import { SessionStore } from "../src/auth/sessionStore.ts";
import {
  ConnectionHub
} from "../src/gateway/connectionHub.ts";
import type {
  ConnectionTransport
} from "../src/gateway/connectionHub.ts";
import {
  GuestCreationRateLimitError,
  RealtimeService
} from "../src/gateway/realtimeService.ts";
import { RoomManager } from "../src/rooms/roomManager.ts";

class FakeTransport implements ConnectionTransport {
  bufferedAmount = 0;

  send(_payload: string): void {}

  close(_code: number, _reason: string): void {}
}

test("guest creation quota spans connections and refills by injected clock", (t) => {
  let nowMs = 1_000;
  const now = () => nowMs;
  const sessions = new SessionStore({
    hmacKey: Buffer.alloc(32, 0x6b),
    now
  });
  const connections = new ConnectionHub();
  const rooms = new RoomManager({ now });
  const service = new RealtimeService({
    sessions,
    connections,
    rooms,
    now,
    guestCreationRateLimit: { capacity: 2, refillPerSecond: 1 }
  });
  t.after(() => rooms.dispose());

  service.createGuest("connection-1", new FakeTransport(), "Alice");
  service.createGuest("connection-2", new FakeTransport(), "Bob");

  let denied: unknown;
  try {
    service.createGuest("connection-3", new FakeTransport(), "Carol");
  } catch (error) {
    denied = error;
  }
  assert.ok(denied instanceof GuestCreationRateLimitError);
  assert.equal(denied.retryAfterMs, 1_000);
  assert.equal(sessions.size, 2);
  assert.equal(connections.size, 2);

  nowMs += 400;
  denied = undefined;
  try {
    service.createGuest("connection-4", new FakeTransport(), "Dana");
  } catch (error) {
    denied = error;
  }
  assert.ok(denied instanceof GuestCreationRateLimitError);
  assert.equal(denied.retryAfterMs, 600);

  nowMs += 600;
  service.createGuest("connection-5", new FakeTransport(), "Eve");
  assert.equal(sessions.size, 3);
  assert.equal(connections.size, 3);
});
