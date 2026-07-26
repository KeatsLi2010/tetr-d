import assert from "node:assert/strict";
import test from "node:test";

import { parseClientMessage } from "../src/gateway/schemas/clientMessages.ts";

test("strict schemas accept the supported handshake and room commands", () => {
  assert.deepEqual(
    parseClientMessage({
      type: "hello",
      protocolVersion: 3,
      buildId: "test"
    }),
    { type: "hello", protocolVersion: 3, buildId: "test" }
  );
  assert.ok(
    parseClientMessage({
      type: "room.ready.set",
      requestId: "ready-1",
      roomId: "room-1",
      expectedRevision: 2,
      ready: true
    })
  );
});

test("client payloads cannot forge actor, time or internal commands", () => {
  assert.equal(
    parseClientMessage({
      type: "room.ready.set",
      requestId: "ready-1",
      roomId: "room-1",
      expectedRevision: 2,
      ready: true,
      actorPlayerId: "host"
    }),
    null
  );
  assert.equal(
    parseClientMessage({
      type: "room.ready.set",
      requestId: "ready-1",
      roomId: "room-1",
      expectedRevision: 2,
      ready: true,
      atMs: 1
    }),
    null
  );
  for (const type of [
    "connection.lost",
    "connection.replace",
    "timer.countdown_elapsed",
    "match.finished",
    "admin.close"
  ]) {
    assert.equal(parseClientMessage({ type }), null);
  }
});

test("request ids, numeric fields and unknown keys are bounded", () => {
  for (const requestId of ["", "bad\0id", "x".repeat(65), "\u7a7a"]) {
    assert.equal(
      parseClientMessage({
        type: "room.create",
        requestId
      }),
      null
    );
  }
  assert.equal(
    parseClientMessage({
      type: "room.join",
      requestId: "join-1",
      roomCode: "ABC234",
      participation: "player",
      unknown: true
    }),
    null
  );
  assert.equal(
    parseClientMessage({
      type: "room.ready.set",
      requestId: "ready-1",
      roomId: "room-1",
      expectedRevision: Number.POSITIVE_INFINITY,
      ready: true
    }),
    null
  );
});

test("match input accepts edges but rejects oversized or forged batches", () => {
  assert.ok(
    parseClientMessage({
      type: "match.input",
      matchId: "match-1",
      inputEpoch: 0,
      sequence: 1,
      clientFrame: 10,
      actions: [{ kind: "rotate", direction: "cw" }]
    })
  );
  assert.equal(
    parseClientMessage({
      type: "match.input",
      matchId: "match-1",
      inputEpoch: 0,
      sequence: 1,
      clientFrame: 10,
      actions: Array.from({ length: 17 }, () => ({ kind: "hardDrop" }))
    }),
    null
  );
});

test("match input accepts discrete actions and bounds drop steps", () => {
  const base = {
    type: "match.input",
    matchId: "match-1",
    inputEpoch: 0,
    sequence: 2,
    clientFrame: 11
  } as const;

  assert.ok(
    parseClientMessage({
      ...base,
      actions: [
        { kind: "move", direction: "left", pressed: true },
        { kind: "softDrop", pressed: false },
        { kind: "moveStep", direction: "right" },
        { kind: "moveToWall", direction: "left" },
        { kind: "softDropStep", cells: 40 },
        { kind: "sonicDrop" },
        { kind: "clearHeld" }
      ]
    })
  );

  for (const cells of [0, 41, 1.5, Number.NaN]) {
    assert.equal(
      parseClientMessage({
        ...base,
        actions: [{ kind: "softDropStep", cells }]
      }),
      null
    );
  }

  assert.equal(
    parseClientMessage({
      ...base,
      actions: [
        {
          kind: "moveStep",
          direction: "left",
          pressed: true
        }
      ]
    }),
    null
  );
});
