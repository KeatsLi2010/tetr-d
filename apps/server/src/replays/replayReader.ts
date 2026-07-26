import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import {
  hashReplayRecordBody,
  parseReplayRecord
} from "./replayHashChain.ts";
import { resolveReplayPaths } from "./replayPaths.ts";
import { isReplayPayload } from "./replayTypes.ts";
import type {
  ReplayEndPayload,
  ReplayFramePayload,
  ReplayHeaderPayload,
  ReplayReadResult,
  ReplayReadStopReason,
  ReplayRecord
} from "./replayTypes.ts";

export interface ReadReplayOptions {
  readonly rootDirectory: string;
  readonly matchId: string;
  readonly source?: "final" | "partial";
}

interface ReadState {
  readonly path: string;
  readonly source: "final" | "partial";
  readonly matchId: string;
  readonly records: ReplayRecord[];
  readonly frames: ReplayFramePayload[];
  header: ReplayHeaderPayload | null;
  end: ReplayEndPayload | null;
  expectedOrdinal: number;
  previousHash: string | null;
}

export async function readReplay(
  options: ReadReplayOptions
): Promise<ReplayReadResult> {
  const source = options.source ?? "final";
  const paths = resolveReplayPaths(options.rootDirectory, options.matchId);
  const state: ReadState = {
    path: source === "final" ? paths.finalPath : paths.partialPath,
    source,
    matchId: options.matchId,
    records: [],
    frames: [],
    header: null,
    end: null,
    expectedOrdinal: 0,
    previousHash: null
  };
  const lines = createInterface({
    input: createReadStream(state.path, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  for await (const line of lines) {
    const failure = verifyLine(line, state);
    if (failure !== null) {
      lines.close();
      return resultFor(state, false, failure);
    }
  }

  if (state.header === null) {
    return resultFor(state, false, "missing-header");
  }
  if (state.end === null) {
    return resultFor(state, false, "eof-without-end");
  }
  if (source === "partial") {
    return resultFor(state, false, "unfinalized-source");
  }
  return resultFor(state, true, "complete");
}

function verifyLine(
  line: string,
  state: ReadState
): ReplayReadStopReason | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return "invalid-json";
  }
  const record = parseReplayRecord(decoded);
  if (record === null) return "invalid-record";
  if (record.ordinal !== state.expectedOrdinal) {
    return "ordinal-mismatch";
  }
  if (record.previousHash !== state.previousHash) {
    return "previous-hash-mismatch";
  }
  if (
    record.hash !== hashReplayRecordBody(
      record.ordinal,
      record.previousHash,
      record.payload
    )
  ) {
    return "hash-mismatch";
  }
  if (!isReplayPayload(record.payload)) return "invalid-record";

  if (state.expectedOrdinal === 0) {
    if (record.payload.kind !== "header") {
      return "invalid-payload-order";
    }
    if (record.payload.matchId !== state.matchId) {
      return "header-match-id-mismatch";
    }
    state.header = record.payload;
  } else if (state.end !== null || record.payload.kind === "header") {
    return "invalid-payload-order";
  } else if (record.payload.kind === "frame") {
    state.frames.push(record.payload);
  } else {
    state.end = record.payload;
  }

  state.records.push(record);
  state.expectedOrdinal += 1;
  state.previousHash = record.hash;
  return null;
}

function resultFor(
  state: ReadState,
  complete: boolean,
  stopReason: ReplayReadStopReason
): ReplayReadResult {
  return Object.freeze({
    path: state.path,
    records: Object.freeze([...state.records]),
    header: state.header,
    frames: Object.freeze([...state.frames]),
    end: state.end,
    complete,
    stopReason
  });
}
