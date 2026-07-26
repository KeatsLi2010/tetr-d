import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readReplay,
  ReplayBackpressureError,
  ReplayWriter
} from "../src/replays/index.ts";

async function temporaryReplayRoot(
  t: test.TestContext
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tetr-d-replay-writer-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("finalize fsyncs and atomically publishes a complete hash chain", async (t) => {
  const rootDirectory = await temporaryReplayRoot(t);
  const writer = await ReplayWriter.create({
    rootDirectory,
    header: {
      kind: "header",
      version: 1,
      matchId: "match-finalize",
      createdAtMs: 12_345,
      metadata: {
        protocolVersion: 1,
        rulesetVersion: "srs-plus-v1",
        players: ["one", "two"],
        tickHz: 240
      }
    }
  });
  await writer.appendFrame({
    kind: "frame",
    serverFrame: 1,
    data: {
      type: "appliedInputs",
      players: [
        { playerId: "one", actions: ["moveLeft"], sourceSequences: [4] }
      ]
    }
  });
  await writer.appendFrame({
    kind: "frame",
    serverFrame: 1,
    data: { type: "state", firstAttack: 2, garbageHole: 7 }
  });

  const finalPath = await writer.finalize({
    kind: "end",
    serverFrame: 80,
    data: { winnerPlayerId: "one", reason: "top-out" }
  });

  await access(finalPath);
  await assert.rejects(access(writer.partialPath), { code: "ENOENT" });
  const decoded = await readReplay({
    rootDirectory,
    matchId: "match-finalize"
  });
  assert.equal(decoded.complete, true);
  assert.equal(decoded.stopReason, "complete");
  assert.equal(decoded.frames.length, 2);
  assert.equal(decoded.end?.serverFrame, 80);
  assert.deepEqual(
    decoded.records.map((record) => record.ordinal),
    [0, 1, 2, 3]
  );
  for (let index = 1; index < decoded.records.length; index += 1) {
    assert.equal(
      decoded.records[index]?.previousHash,
      decoded.records[index - 1]?.hash
    );
  }
  const file = await readFile(finalPath, "utf8");
  assert.equal(file.endsWith("\n"), true);
});

test("concurrent append calls preserve invocation order", async (t) => {
  const rootDirectory = await temporaryReplayRoot(t);
  const writer = await ReplayWriter.create({
    rootDirectory,
    header: {
      kind: "header",
      version: 1,
      matchId: "match-order",
      createdAtMs: 1
    },
    maxPendingRecords: 256
  });
  const appends = Array.from({ length: 100 }, (_, index) =>
    writer.appendFrame({
      kind: "frame",
      serverFrame: Math.floor(index / 2),
      data: { invocationIndex: index }
    })
  );
  const finalized = writer.finalize({
    kind: "end",
    serverFrame: 50,
    data: { reason: "test" }
  });
  await Promise.all(appends);
  await finalized;

  const decoded = await readReplay({
    rootDirectory,
    matchId: "match-order"
  });
  assert.deepEqual(
    decoded.frames.map((frame) =>
      (frame.data as { invocationIndex: number }).invocationIndex
    ),
    Array.from({ length: 100 }, (_, index) => index)
  );
});

test("bounded pending queue rejects instead of dropping records", async (t) => {
  const rootDirectory = await temporaryReplayRoot(t);
  const writer = await ReplayWriter.create({
    rootDirectory,
    header: {
      kind: "header",
      version: 1,
      matchId: "match-pressure",
      createdAtMs: 1
    },
    maxPendingRecords: 2
  });
  const first = writer.appendFrame({
    kind: "frame",
    serverFrame: 1,
    data: { index: 1 }
  });
  const second = writer.appendFrame({
    kind: "frame",
    serverFrame: 2,
    data: { index: 2 }
  });
  assert.equal(writer.pendingCount, 2);
  assert.throws(
    () => writer.appendFrame({
      kind: "frame",
      serverFrame: 3,
      data: { index: 3 }
    }),
    ReplayBackpressureError
  );

  await Promise.all([first, second]);
  assert.equal(writer.pendingCount, 0);
  await writer.appendFrame({
    kind: "frame",
    serverFrame: 3,
    data: { index: 3 }
  });
  await writer.finalize({
    kind: "end",
    serverFrame: 4,
    data: { reason: "test" }
  });
  const decoded = await readReplay({
    rootDirectory,
    matchId: "match-pressure"
  });
  assert.deepEqual(
    decoded.frames.map((frame) => (frame.data as { index: number }).index),
    [1, 2, 3]
  );
});
