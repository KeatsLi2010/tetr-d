import { createHash } from "node:crypto";

import {
  assertReplayJsonValue
} from "./replayTypes.ts";
import type {
  ReplayPayload,
  ReplayRecord
} from "./replayTypes.ts";

export const REPLAY_HASH_PATTERN = /^[a-f0-9]{64}$/;

export function hashReplayRecordBody(
  ordinal: number,
  previousHash: string | null,
  payload: ReplayPayload
): string {
  const body = JSON.stringify({ ordinal, previousHash, payload });
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function createReplayRecord(
  ordinal: number,
  previousHash: string | null,
  payload: ReplayPayload
): ReplayRecord {
  return {
    ordinal,
    previousHash,
    payload,
    hash: hashReplayRecordBody(ordinal, previousHash, payload)
  };
}

export function serializeReplayRecord(record: ReplayRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function parseReplayRecord(value: unknown): ReplayRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    keys.length !== 4
    || !["ordinal", "previousHash", "payload", "hash"].every(
      (key) => Object.hasOwn(candidate, key)
    )
    || !Number.isSafeInteger(candidate.ordinal)
    || (candidate.ordinal as number) < 0
    || !(
      candidate.previousHash === null
      || (
        typeof candidate.previousHash === "string"
        && REPLAY_HASH_PATTERN.test(candidate.previousHash)
      )
    )
    || typeof candidate.hash !== "string"
    || !REPLAY_HASH_PATTERN.test(candidate.hash)
  ) {
    return null;
  }
  try {
    assertReplayJsonValue(candidate.payload, "$.payload");
  } catch {
    return null;
  }
  return candidate as unknown as ReplayRecord;
}
