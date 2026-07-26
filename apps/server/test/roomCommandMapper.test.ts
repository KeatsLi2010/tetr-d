import assert from "node:assert/strict";
import test from "node:test";

import type {
  RoomClientMessage
} from "../../../packages/protocol/src/roomMessages.ts";
import {
  mapRoomClientMessageToUserCommand
} from "../src/gateway/roomCommandMapper.ts";

const mutation = {
  requestId: "request-1",
  roomId: "room-1",
  expectedRevision: 7
} as const;

test("maps every supported room mutation field by field", () => {
  const cases: readonly [
    RoomClientMessage,
    Readonly<Record<string, unknown>>
  ][] = [
    [
      { type: "room.leave", ...mutation },
      {
        type: "member.leave",
        requestId: "request-1",
        expectedRevision: 7
      }
    ],
    [
      { type: "room.seat.set", ...mutation, seat: 1 },
      {
        type: "seat.set",
        requestId: "request-1",
        expectedRevision: 7,
        seat: 1
      }
    ],
    [
      { type: "room.ready.set", ...mutation, ready: true },
      {
        type: "ready.set",
        requestId: "request-1",
        expectedRevision: 7,
        ready: true
      }
    ],
    [
      {
        type: "room.settings.update",
        ...mutation,
        patch: { targetWins: 5, allowSpectators: false }
      },
      {
        type: "settings.update",
        requestId: "request-1",
        expectedRevision: 7,
        patch: { targetWins: 5, allowSpectators: false }
      }
    ],
    [
      {
        type: "room.host.transfer",
        ...mutation,
        targetPlayerId: "player-2"
      },
      {
        type: "host.transfer",
        requestId: "request-1",
        expectedRevision: 7,
        targetPlayerId: "player-2"
      }
    ],
    [
      {
        type: "room.member.kick",
        ...mutation,
        targetPlayerId: "player-2"
      },
      {
        type: "member.kick",
        requestId: "request-1",
        expectedRevision: 7,
        targetPlayerId: "player-2"
      }
    ],
    [
      {
        type: "room.series.rematch",
        ...mutation,
        accepted: true
      },
      {
        type: "series.rematch",
        requestId: "request-1",
        expectedRevision: 7,
        accepted: true
      }
    ],
    [
      { type: "room.close", ...mutation },
      {
        type: "room.close",
        requestId: "request-1",
        expectedRevision: 7
      }
    ]
  ];

  for (const [message, expectedCommand] of cases) {
    const result = mapRoomClientMessageToUserCommand(message);
    assert.equal(result.kind, "mapped");
    if (result.kind !== "mapped") continue;
    assert.equal(result.roomId, "room-1");
    assert.deepEqual(result.command, expectedCommand);
    assert.equal("roomId" in result.command, false);
    assert.equal("actorPlayerId" in result.command, false);
    assert.equal("atMs" in result.command, false);
  }
});

test("create and join are explicitly not actor mutation mappings", () => {
  const create = mapRoomClientMessageToUserCommand({
    type: "room.create",
    requestId: "create-1",
    settings: { targetWins: 3 }
  });
  const join = mapRoomClientMessageToUserCommand({
    type: "room.join",
    requestId: "join-1",
    roomCode: "ABC234",
    participation: "player",
    preferredSeat: 1
  });

  assert.deepEqual(create, {
    kind: "not_mappable",
    messageType: "room.create",
    reason: "create_or_join"
  });
  assert.deepEqual(join, {
    kind: "not_mappable",
    messageType: "room.join",
    reason: "create_or_join"
  });
});

test("internal actor fields are rejected even if a caller bypasses schemas", () => {
  const internalFields = [
    "actorPlayerId",
    "atMs",
    "player",
    "connectionId"
  ] as const;

  for (const internalField of internalFields) {
    const message = {
      type: "room.ready.set",
      requestId: "request",
      roomId: "room",
      expectedRevision: 1,
      ready: true,
      [internalField]: "untrusted"
    } as unknown as RoomClientMessage;

    assert.deepEqual(mapRoomClientMessageToUserCommand(message), {
      kind: "not_mappable",
      messageType: "room.ready.set",
      reason: "internal_field"
    });
  }
});

test("settings mapping copies only supported setting fields", () => {
  const message = {
    type: "room.settings.update",
    requestId: "request",
    roomId: "room",
    expectedRevision: 1,
    patch: {
      targetWins: 2,
      allowSpectators: true,
      countdownMs: 0,
      absoluteTtlMs: Number.MAX_SAFE_INTEGER
    }
  } as unknown as RoomClientMessage;

  const result = mapRoomClientMessageToUserCommand(message);
  assert.equal(result.kind, "mapped");
  if (result.kind !== "mapped") return;
  assert.deepEqual(result.command, {
    type: "settings.update",
    requestId: "request",
    expectedRevision: 1,
    patch: {
      targetWins: 2,
      allowSpectators: true
    }
  });
});

test("null seat and false flags are preserved exactly", () => {
  const seat = mapRoomClientMessageToUserCommand({
    type: "room.seat.set",
    ...mutation,
    seat: null
  });
  const ready = mapRoomClientMessageToUserCommand({
    type: "room.ready.set",
    ...mutation,
    ready: false
  });
  const rematch = mapRoomClientMessageToUserCommand({
    type: "room.series.rematch",
    ...mutation,
    accepted: false
  });

  assert.equal(seat.kind, "mapped");
  assert.equal(ready.kind, "mapped");
  assert.equal(rematch.kind, "mapped");
  if (
    seat.kind !== "mapped" ||
    ready.kind !== "mapped" ||
    rematch.kind !== "mapped"
  ) {
    return;
  }
  assert.deepEqual(seat.command, {
    type: "seat.set",
    requestId: "request-1",
    expectedRevision: 7,
    seat: null
  });
  assert.deepEqual(ready.command, {
    type: "ready.set",
    requestId: "request-1",
    expectedRevision: 7,
    ready: false
  });
  assert.deepEqual(rematch.command, {
    type: "series.rematch",
    requestId: "request-1",
    expectedRevision: 7,
    accepted: false
  });
});
