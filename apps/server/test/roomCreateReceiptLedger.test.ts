import assert from "node:assert/strict";
import test from "node:test";

import {
  RoomCreateReceiptLedger
} from "../src/gateway/roomCreateReceiptLedger.ts";

test("same canonical create payload replays its original receipt", () => {
  const ledger = new RoomCreateReceiptLedger({ now: () => 1_000 });
  ledger.record(
    {
      sessionId: "session-a",
      requestId: "create-1",
      settings: { targetWins: 3, allowSpectators: false }
    },
    { roomId: "room-original", revision: 7 }
  );

  assert.deepEqual(
    ledger.lookup({
      sessionId: "session-a",
      requestId: "create-1",
      settings: { allowSpectators: false, targetWins: 3 }
    }),
    {
      kind: "replay",
      receipt: { roomId: "room-original", revision: 7 }
    }
  );
  assert.equal(ledger.size, 1);
});

test("missing and empty settings share one canonical payload", () => {
  const ledger = new RoomCreateReceiptLedger({ now: () => 1_000 });
  ledger.record(
    { sessionId: "session-a", requestId: "create-1" },
    { roomId: "room-one", revision: 0 }
  );

  assert.equal(
    ledger.lookup({
      sessionId: "session-a",
      requestId: "create-1",
      settings: {}
    }).kind,
    "replay"
  );
});

test("same session and request ID with another payload is rejected", () => {
  const ledger = new RoomCreateReceiptLedger({ now: () => 1_000 });
  ledger.record(
    {
      sessionId: "session-a",
      requestId: "create-1",
      settings: { targetWins: 3 }
    },
    { roomId: "room-one", revision: 0 }
  );

  assert.deepEqual(
    ledger.lookup({
      sessionId: "session-a",
      requestId: "create-1",
      settings: { targetWins: 5 }
    }),
    { kind: "request_id_reused" }
  );
  assert.deepEqual(
    ledger.lookup({
      sessionId: "session-b",
      requestId: "create-1",
      settings: { targetWins: 5 }
    }),
    { kind: "miss" }
  );
});

test("receipts expire exactly at the configured TTL", () => {
  let nowMs = 1_000;
  const ledger = new RoomCreateReceiptLedger({
    ttlMs: 50,
    now: () => nowMs
  });
  ledger.record(
    { sessionId: "session-a", requestId: "create-1" },
    { roomId: "room-one", revision: 0 }
  );

  nowMs = 1_049;
  assert.equal(
    ledger.lookup({ sessionId: "session-a", requestId: "create-1" }).kind,
    "replay"
  );
  nowMs = 1_050;
  assert.equal(
    ledger.lookup({ sessionId: "session-a", requestId: "create-1" }).kind,
    "miss"
  );
  assert.equal(ledger.size, 0);
});

test("capacity evicts the oldest live receipt deterministically", () => {
  let nowMs = 1_000;
  const ledger = new RoomCreateReceiptLedger({
    ttlMs: 1_000,
    maxEntries: 2,
    now: () => nowMs
  });
  const record = (requestId: string, roomId: string) => {
    ledger.record(
      { sessionId: "session-a", requestId },
      { roomId, revision: 0 }
    );
    nowMs += 1;
  };
  record("create-1", "room-one");
  record("create-2", "room-two");
  record("create-3", "room-three");

  assert.equal(ledger.size, 2);
  assert.equal(
    ledger.lookup({ sessionId: "session-a", requestId: "create-1" }).kind,
    "miss"
  );
  assert.equal(
    ledger.lookup({ sessionId: "session-a", requestId: "create-2" }).kind,
    "replay"
  );
});
