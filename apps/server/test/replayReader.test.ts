import assert from "node:assert/strict";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readReplay,
  ReplayWriter,
  resolveReplayPaths
} from "../src/replays/index.ts";

async function temporaryReplayRoot(
  t: test.TestContext
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tetr-d-replay-reader-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function createReplay(
  rootDirectory: string,
  matchId: string
): Promise<{ readonly finalPath: string; readonly partialPath: string }> {
  const writer = await ReplayWriter.create({
    rootDirectory,
    header: {
      kind: "header",
      version: 1,
      matchId,
      createdAtMs: 1
    }
  });
  await writer.appendFrame({
    kind: "frame",
    serverFrame: 1,
    data: { value: "first" }
  });
  await writer.appendFrame({
    kind: "frame",
    serverFrame: 2,
    data: { value: "second" }
  });
  await writer.finalize({
    kind: "end",
    serverFrame: 3,
    data: { reason: "test" }
  });
  return {
    finalPath: writer.finalPath,
    partialPath: writer.partialPath
  };
}

test("truncated tail returns only the verified prefix", async (t) => {
  const rootDirectory = await temporaryReplayRoot(t);
  const paths = await createReplay(rootDirectory, "match-truncated");
  const complete = await readFile(paths.finalPath);
  await writeFile(
    paths.partialPath,
    complete.subarray(0, complete.byteLength - 12)
  );

  const decoded = await readReplay({
    rootDirectory,
    matchId: "match-truncated",
    source: "partial"
  });
  assert.equal(decoded.complete, false);
  assert.equal(decoded.stopReason, "invalid-json");
  assert.equal(decoded.records.length, 3);
  assert.equal(decoded.frames.length, 2);
  assert.equal(decoded.end, null);
});

test("tampering stops at the first invalid hash and never resumes", async (t) => {
  const rootDirectory = await temporaryReplayRoot(t);
  const paths = await createReplay(rootDirectory, "match-tampered");
  const lines = (await readFile(paths.finalPath, "utf8"))
    .trimEnd()
    .split("\n");
  const changed = JSON.parse(lines[1]!) as {
    payload: { data: { value: string } };
  };
  changed.payload.data.value = "tampered";
  lines[1] = JSON.stringify(changed);
  await writeFile(paths.finalPath, `${lines.join("\n")}\n`, "utf8");

  const decoded = await readReplay({
    rootDirectory,
    matchId: "match-tampered"
  });
  assert.equal(decoded.complete, false);
  assert.equal(decoded.stopReason, "hash-mismatch");
  assert.equal(decoded.records.length, 1);
  assert.equal(decoded.frames.length, 0);
  assert.equal(decoded.end, null);
});

test("a valid end in a partial file is never reported complete", async (t) => {
  const rootDirectory = await temporaryReplayRoot(t);
  const paths = await createReplay(rootDirectory, "match-partial");
  await copyFile(paths.finalPath, paths.partialPath);

  const decoded = await readReplay({
    rootDirectory,
    matchId: "match-partial",
    source: "partial"
  });
  assert.equal(decoded.complete, false);
  assert.equal(decoded.stopReason, "unfinalized-source");
  assert.equal(decoded.end?.kind, "end");
});

test("matchId cannot escape the replay root", async (t) => {
  const rootDirectory = await temporaryReplayRoot(t);
  const unsafeIds = [
    "",
    ".",
    "..",
    "../outside",
    "..\\outside",
    "nested/replay",
    "nested\\replay",
    "C:outside",
    "%2e%2e",
    "CON",
    "a".repeat(129)
  ];
  for (const matchId of unsafeIds) {
    assert.throws(
      () => resolveReplayPaths(rootDirectory, matchId),
      /matchId/
    );
    await assert.rejects(
      ReplayWriter.create({
        rootDirectory,
        header: {
          kind: "header",
          version: 1,
          matchId,
          createdAtMs: 1
        }
      }),
      /matchId/
    );
  }
  const safe = resolveReplayPaths(rootDirectory, "Match_01-test");
  assert.equal(safe.rootDirectory, rootDirectory);
  assert.equal(
    safe.finalPath,
    join(rootDirectory, "Match_01-test.jsonl")
  );
});
