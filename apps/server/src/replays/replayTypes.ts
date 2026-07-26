export type ReplayJsonPrimitive = string | number | boolean | null;

export type ReplayJsonValue =
  | ReplayJsonPrimitive
  | readonly ReplayJsonValue[]
  | ReplayJsonObject;

export interface ReplayJsonObject {
  readonly [key: string]: ReplayJsonValue;
}

export interface ReplayHeaderPayload {
  readonly kind: "header";
  readonly version: 1;
  readonly matchId: string;
  readonly createdAtMs: number;
  readonly metadata?: ReplayJsonObject;
}

export interface ReplayFramePayload {
  readonly kind: "frame";
  readonly serverFrame: number;
  readonly data: ReplayJsonValue;
}

export interface ReplayEndPayload {
  readonly kind: "end";
  readonly serverFrame: number;
  readonly data: ReplayJsonValue;
}

export type ReplayPayload =
  | ReplayHeaderPayload
  | ReplayFramePayload
  | ReplayEndPayload;

export interface ReplayRecord<TPayload extends ReplayPayload = ReplayPayload> {
  readonly ordinal: number;
  readonly previousHash: string | null;
  readonly payload: TPayload;
  readonly hash: string;
}

export type ReplayReadStopReason =
  | "complete"
  | "eof-without-end"
  | "unfinalized-source"
  | "missing-header"
  | "invalid-json"
  | "invalid-record"
  | "ordinal-mismatch"
  | "previous-hash-mismatch"
  | "hash-mismatch"
  | "header-match-id-mismatch"
  | "invalid-payload-order";

export interface ReplayReadResult {
  readonly path: string;
  readonly records: readonly ReplayRecord[];
  readonly header: ReplayHeaderPayload | null;
  readonly frames: readonly ReplayFramePayload[];
  readonly end: ReplayEndPayload | null;
  readonly complete: boolean;
  readonly stopReason: ReplayReadStopReason;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(value);
  if (keys.length < required.length) return false;
  if (keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    return false;
  }
  return required.every((key) => Object.hasOwn(value, key));
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

export function assertReplayJsonValue(
  value: unknown,
  path = "$",
  ancestors = new Set<object>()
): asserts value is ReplayJsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${path} must contain only finite JSON numbers.`);
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} is not a JSON value.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular reference.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${path}[${index}] is an array hole.`);
        }
        assertReplayJsonValue(value[index], `${path}[${index}]`, ancestors);
      }
      return;
    }
    if (!isPlainObject(value)) {
      throw new TypeError(`${path} must be a plain JSON object.`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${path} must not contain symbol keys.`);
    }
    for (const [key, child] of Object.entries(value)) {
      assertReplayJsonValue(child, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function isReplayPayload(value: unknown): value is ReplayPayload {
  if (!isPlainObject(value)) return false;
  if (value.kind === "header") {
    if (
      !hasOnlyKeys(
        value,
        ["kind", "version", "matchId", "createdAtMs"],
        ["metadata"]
      )
      || value.version !== 1
      || typeof value.matchId !== "string"
      || !isSafeNonNegativeInteger(value.createdAtMs)
    ) {
      return false;
    }
    if (Object.hasOwn(value, "metadata")) {
      try {
        assertReplayJsonValue(value.metadata, "$.metadata");
      } catch {
        return false;
      }
      return isPlainObject(value.metadata) && !Array.isArray(value.metadata);
    }
    return true;
  }
  if (value.kind === "frame" || value.kind === "end") {
    if (
      !hasOnlyKeys(value, ["kind", "serverFrame", "data"])
      || !isSafeNonNegativeInteger(value.serverFrame)
    ) {
      return false;
    }
    try {
      assertReplayJsonValue(value.data, "$.data");
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function assertReplayPayload(
  value: unknown
): asserts value is ReplayPayload {
  if (!isReplayPayload(value)) {
    throw new TypeError("Invalid replay payload.");
  }
}
