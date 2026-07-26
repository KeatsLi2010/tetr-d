import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectionHub
} from "../src/gateway/connectionHub.ts";
import type {
  ConnectionIdentity,
  ConnectionTransport
} from "../src/gateway/connectionHub.ts";

class FakeTransport implements ConnectionTransport {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: { readonly code: number; readonly reason: string }[] = [];
  failSend = false;
  failClose = false;

  send(payload: string): void {
    if (this.failSend) throw new Error("send failed");
    this.sent.push(payload);
  }

  close(code: number, reason: string): void {
    if (this.failClose) throw new Error("close failed");
    this.closes.push({ code, reason });
  }
}

function identity(
  sessionId: string,
  connectionId: string,
  connectionGeneration: number
): ConnectionIdentity {
  return { sessionId, connectionId, connectionGeneration };
}

function bind(
  hub: ConnectionHub,
  current: ConnectionIdentity,
  transport: FakeTransport,
  roomId: string | null
): void {
  const result = hub.bind({ ...current, transport, roomId });
  assert.ok(
    result.status === "bound" ||
      result.status === "replaced" ||
      result.status === "already_bound"
  );
}

test("new generation replaces old transport and blocks stale writes", () => {
  const hub = new ConnectionHub();
  const oldTransport = new FakeTransport();
  const newTransport = new FakeTransport();
  const oldIdentity = identity("session-a", "connection-old", 0);
  const newIdentity = identity("session-a", "connection-new", 1);

  assert.deepEqual(
    hub.bind({
      ...oldIdentity,
      roomId: "room-a",
      transport: oldTransport
    }),
    { status: "bound" }
  );
  assert.deepEqual(hub.send(oldIdentity, "first"), {
    status: "accepted",
    payloadBytes: 5
  });
  assert.deepEqual(
    hub.bind({
      ...newIdentity,
      roomId: "room-a",
      transport: newTransport
    }),
    {
      status: "replaced",
      replacedConnectionId: "connection-old"
    }
  );

  assert.deepEqual(oldTransport.closes, [
    { code: 4001, reason: "superseded" }
  ]);
  assert.deepEqual(hub.send(oldIdentity, "stale"), { status: "stale" });
  assert.deepEqual(hub.send(newIdentity, "current"), {
    status: "accepted",
    payloadBytes: 7
  });
  assert.deepEqual(oldTransport.sent, ["first"]);
  assert.deepEqual(newTransport.sent, ["current"]);
  assert.equal(hub.size, 1);
  assert.equal(hub.roomSize("room-a"), 1);
});

test("equal or lower generations cannot replace a current connection", () => {
  const hub = new ConnectionHub();
  const currentTransport = new FakeTransport();
  const otherTransport = new FakeTransport();
  const current = identity("session", "connection-current", 3);
  bind(hub, current, currentTransport, null);

  assert.deepEqual(
    hub.bind({
      ...current,
      connectionId: "connection-conflict",
      transport: otherTransport,
      roomId: null
    }),
    { status: "stale" }
  );
  assert.deepEqual(
    hub.bind({
      sessionId: "session",
      connectionId: "connection-old",
      connectionGeneration: 2,
      transport: otherTransport,
      roomId: null
    }),
    { status: "stale" }
  );
  assert.deepEqual(
    hub.bind({ ...current, transport: currentTransport, roomId: null }),
    { status: "already_bound" }
  );
  assert.equal(hub.isCurrent(current), true);
  assert.deepEqual(currentTransport.closes, []);
});

test("unbind and room mutation require generation and connection id", () => {
  const hub = new ConnectionHub();
  const transport = new FakeTransport();
  const current = identity("session", "connection", 4);
  bind(hub, current, transport, "room-old");

  assert.deepEqual(
    hub.setRoom({ ...current, connectionGeneration: 3 }, "room-new"),
    { status: "stale" }
  );
  assert.deepEqual(
    hub.unbind({ ...current, connectionId: "another-connection" }),
    { status: "stale" }
  );
  assert.equal(hub.roomSize("room-old"), 1);

  assert.deepEqual(hub.setRoom(current, "room-new"), { status: "updated" });
  assert.equal(hub.roomSize("room-old"), 0);
  assert.equal(hub.roomSize("room-new"), 1);
  assert.deepEqual(hub.unbind(current), { status: "updated" });
  assert.equal(hub.size, 0);
  assert.equal(hub.roomSize("room-new"), 0);
  assert.deepEqual(hub.send(current, "after-unbind"), {
    status: "not_found"
  });
});

test("room broadcast reaches only current members of that room", () => {
  const hub = new ConnectionHub();
  const alice = new FakeTransport();
  const bobOld = new FakeTransport();
  const bobNew = new FakeTransport();
  const spectator = new FakeTransport();
  const aliceId = identity("alice-session", "alice-connection", 0);
  const bobOldId = identity("bob-session", "bob-old", 0);
  const bobNewId = identity("bob-session", "bob-new", 1);

  bind(hub, aliceId, alice, "room-1");
  bind(hub, bobOldId, bobOld, "room-1");
  bind(hub, identity("spectator-session", "spectator", 0), spectator, "room-2");
  bind(hub, bobNewId, bobNew, "room-1");

  const result = hub.broadcastRoom("room-1", "state");

  assert.equal(result.attempted, 2);
  assert.equal(result.accepted, 2);
  assert.deepEqual(
    result.entries.map((entry) => entry.sessionId).sort(),
    ["alice-session", "bob-session"]
  );
  assert.deepEqual(alice.sent, ["state"]);
  assert.deepEqual(bobOld.sent, []);
  assert.deepEqual(bobNew.sent, ["state"]);
  assert.deepEqual(spectator.sent, []);
});

test("injectable reject policy keeps a pressured connection registered", () => {
  const contexts: unknown[] = [];
  const hub = new ConnectionHub({
    maxBufferedBytes: 10,
    onBackpressure: (context) => {
      contexts.push(context);
      return "reject";
    }
  });
  const transport = new FakeTransport();
  transport.bufferedAmount = 8;
  const current = identity("session", "connection", 0);
  bind(hub, current, transport, "room");

  // UTF-8 byte length is used: this character is three bytes.
  assert.deepEqual(hub.send(current, "你"), {
    status: "backpressure_rejected",
    payloadBytes: 3,
    bufferedBytes: 8
  });
  assert.equal(contexts.length, 1);
  assert.equal(hub.isCurrent(current), true);
  assert.deepEqual(transport.sent, []);
  assert.deepEqual(transport.closes, []);

  transport.bufferedAmount = 0;
  assert.equal(hub.send(current, "你").status, "accepted");
  assert.deepEqual(transport.sent, ["你"]);
});

test("disconnect policy atomically detaches pressured connections", () => {
  const hub = new ConnectionHub({
    maxBufferedBytes: 4,
    onBackpressure: () => "disconnect"
  });
  const transport = new FakeTransport();
  transport.bufferedAmount = 4;
  const current = identity("session", "connection", 0);
  bind(hub, current, transport, "room");

  assert.deepEqual(hub.send(current, "x"), {
    status: "backpressure_disconnected",
    payloadBytes: 1,
    bufferedBytes: 4
  });
  assert.equal(hub.isCurrent(current), false);
  assert.equal(hub.roomSize("room"), 0);
  assert.deepEqual(transport.closes, [
    { code: 1013, reason: "backpressure" }
  ]);
  assert.deepEqual(hub.unbind(current), { status: "not_found" });
});

test("synchronous send failure detaches even if transport close throws", () => {
  const hub = new ConnectionHub();
  const transport = new FakeTransport();
  transport.failSend = true;
  transport.failClose = true;
  const current = identity("session", "connection", 0);
  bind(hub, current, transport, "room");

  assert.deepEqual(hub.send(current, "payload"), {
    status: "send_failed",
    payloadBytes: 7
  });
  assert.equal(hub.isCurrent(current), false);
  assert.equal(hub.roomSize("room"), 0);
});

test("invalid identities and limits fail before registry mutation", () => {
  assert.throws(
    () => new ConnectionHub({ maxBufferedBytes: 0 }),
    /maxBufferedBytes/
  );
  const hub = new ConnectionHub();
  const transport = new FakeTransport();
  assert.throws(
    () =>
      hub.bind({
        sessionId: "",
        connectionId: "connection",
        connectionGeneration: 0,
        roomId: null,
        transport
      }),
    /sessionId/
  );
  assert.equal(hub.size, 0);
});
