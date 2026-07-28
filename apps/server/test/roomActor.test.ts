import assert from "node:assert/strict";
import test from "node:test";

import { createRoom } from "../../../packages/room-core/src/room.ts";
import { RoomActor } from "../src/roomActor.ts";
import type {
  RoomActorPrincipal,
  RoomUserCommand
} from "../src/roomActor.ts";
import { RoomRegistry, generateRoomCode } from "../src/roomRegistry.ts";

const HOST: RoomActorPrincipal = {
  sessionId: "session-host",
  player: { playerId: "host", displayName: "Host" },
  connectionId: "connection-host",
  connectionGeneration: 0
};

function actor(now: () => number = () => 1_100): RoomActor {
  return new RoomActor(
    createRoom({
      roomId: "actor-room",
      roomCode: "ACT234",
      creator: HOST.player,
      connectionId: HOST.connectionId,
      nowMs: 1_000
    }),
    { now }
  );
}

test("actor serializes concurrent commands against one room revision", async () => {
  const room = actor();
  const left: RoomUserCommand = {
    type: "settings.update",
    requestId: "request-left",
    expectedRevision: 1,
    patch: { targetWins: 2 }
  };
  const right: RoomUserCommand = {
    type: "settings.update",
    requestId: "request-right",
    expectedRevision: 1,
    patch: { targetWins: 5 }
  };

  const [first, second] = await Promise.all([
    room.dispatchUser(HOST, left),
    room.dispatchUser(HOST, right)
  ]);

  assert.equal(first.receipt.kind, "committed");
  assert.equal(second.receipt.kind, "rejected");
  if (second.receipt.kind === "rejected") {
    assert.equal(second.receipt.code, "REVISION_CONFLICT");
  }
  assert.equal(room.snapshot.settings.targetWins, 2);
  assert.equal(room.snapshot.revision, 2);
});

test("idempotent replay returns the original receipt without effects", async () => {
  const room = actor();
  const command: RoomUserCommand = {
    type: "settings.update",
    requestId: "request-idempotent",
    expectedRevision: 1,
    patch: { targetWins: 5 }
  };

  const first = await room.dispatchUser(HOST, command);
  const duplicate = await room.dispatchUser(HOST, { ...command });

  assert.equal(first.replayed, false);
  assert.ok(first.effects.length > 0);
  assert.equal(duplicate.replayed, true);
  assert.deepEqual(duplicate.receipt, first.receipt);
  assert.deepEqual(duplicate.effects, []);
  assert.strictEqual(duplicate.state, room.snapshot);
  assert.equal(room.snapshot.revision, 2);
});

test("historical replay never returns an old room snapshot", async () => {
  const room = actor();
  const first: RoomUserCommand = {
    type: "settings.update",
    requestId: "request-first",
    expectedRevision: 1,
    patch: { targetWins: 2 }
  };
  await room.dispatchUser(HOST, first);
  await room.dispatchUser(HOST, {
    type: "settings.update",
    requestId: "request-second",
    expectedRevision: 2,
    patch: { targetWins: 5 }
  });

  const replay = await room.dispatchUser(HOST, first);

  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.kind, "committed");
  if (replay.receipt.kind === "committed") {
    assert.equal(replay.receipt.revision, 2);
  }
  assert.equal(replay.state.revision, 3);
  assert.equal(replay.state.settings.targetWins, 5);
  assert.deepEqual(replay.effects, []);
});

test("reusing an id for a different payload is rejected without mutation", async () => {
  const room = actor();
  const first: RoomUserCommand = {
    type: "settings.update",
    requestId: "request-reused",
    expectedRevision: 1,
    patch: { targetWins: 2 }
  };
  await room.dispatchUser(HOST, first);
  const revision = room.snapshot.revision;
  const reused = await room.dispatchUser(HOST, {
    ...first,
    patch: { targetWins: 5 }
  });

  assert.equal(reused.receipt.kind, "rejected");
  if (reused.receipt.kind === "rejected") {
    assert.equal(reused.receipt.code, "REQUEST_ID_REUSED");
  }
  assert.deepEqual(reused.effects, []);
  assert.equal(room.snapshot.revision, revision);
  assert.equal(room.snapshot.settings.targetWins, 2);
});

test("request ids have a bounded safe ASCII format", async () => {
  const room = actor();
  for (const requestId of ["", "bad\\0id", "x".repeat(65), "\\u7a7a"]) {
    const result = await room.dispatchUser(HOST, {
      type: "settings.update",
      requestId,
      expectedRevision: 1,
      patch: { targetWins: 5 }
    });
    assert.equal(result.receipt.kind, "rejected");
    if (result.receipt.kind === "rejected") {
      assert.equal(result.receipt.code, "INVALID_COMMAND");
    }
  }
  assert.equal(room.snapshot.revision, 1);
});

test("actor injects its trusted clock instead of accepting command time", async () => {
  const room = actor();
  const command = {
    type: "settings.update",
    requestId: "trusted-time",
    expectedRevision: 1,
    patch: { targetWins: 5 },
    atMs: Number.MAX_SAFE_INTEGER
  } as unknown as RoomUserCommand;

  const result = await room.dispatchUser(HOST, command);

  assert.equal(result.receipt.kind, "committed");
  assert.equal(room.snapshot.updatedAtMs, 1_100);
  assert.equal(room.snapshot.phase, "lobby");
});

test("registry retries code collisions and resolves codes case-insensitively", () => {
  const codes = ["ABC234", "ABC234", "DEF567"];
  let roomNumber = 0;
  const registry = new RoomRegistry({
    codeFactory: () => codes.shift() ?? "GHJ678",
    roomIdFactory: () => `room-${++roomNumber}`
  });
  const input = {
    creator: { playerId: "host", displayName: "Host" },
    connectionId: "connection-host",
    nowMs: 1_000
  };

  const first = registry.create(input);
  const second = registry.create({
    ...input,
    creator: { playerId: "host-2", displayName: "Host 2" },
    connectionId: "connection-host-2"
  });

  assert.equal(first.roomCode, "ABC234");
  assert.equal(second.roomCode, "DEF567");
  assert.strictEqual(registry.getByCode("def567"), second);
  assert.equal(registry.size, 2);
  assert.equal(registry.remove(first.roomId), true);
  assert.equal(registry.getByCode("ABC234"), null);
});

test("registry preserves a requested room code and rejects duplicates", () => {
  let roomNumber = 0;
  const registry = new RoomRegistry({
    codeFactory: () => "ZZZ999",
    roomIdFactory: () => `custom-room-${++roomNumber}`
  });
  const input = {
    creator: { playerId: "custom-host", displayName: "Custom Host" },
    connectionId: "custom-connection",
    nowMs: 1_000,
    roomCode: "abc234"
  };

  const created = registry.create(input);

  assert.equal(created.roomCode, "ABC234");
  assert.strictEqual(registry.getByCode("abc234"), created);
  assert.throws(
    () => registry.create({
      ...input,
      creator: { playerId: "custom-host-2", displayName: "Custom Host 2" },
      connectionId: "custom-connection-2",
      roomCode: "ABC234"
    }),
    /ROOM_CODE_TAKEN/
  );
  assert.equal(roomNumber, 1);
});

test("generated invite codes exclude ambiguous characters", () => {
  for (let index = 0; index < 100; index += 1) {
    assert.match(generateRoomCode(), /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  }
});
