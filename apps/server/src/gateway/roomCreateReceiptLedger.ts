import type {
  RoomSettings
} from "../../../../packages/room-core/src/model.ts";

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

export interface RoomCreateReceipt {
  readonly roomId: string;
  readonly revision: number;
}

export interface RoomCreateReceiptKey {
  readonly sessionId: string;
  readonly requestId: string;
  readonly roomCode?: string;
  readonly settings?: Partial<RoomSettings>;
}

export type RoomCreateReceiptLookup =
  | { readonly kind: "miss" }
  | { readonly kind: "request_id_reused" }
  | {
      readonly kind: "replay";
      readonly receipt: RoomCreateReceipt;
    };

export interface RoomCreateReceiptLedgerOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface StoredReceipt {
  readonly payload: string;
  readonly receipt: RoomCreateReceipt;
  readonly expiresAtMs: number;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Room create payload contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  throw new TypeError("Room create payload is not canonical JSON.");
}

function entryKey(input: RoomCreateReceiptKey): string {
  return JSON.stringify([input.sessionId, input.requestId]);
}

function payloadKey(input: RoomCreateReceiptKey): string {
  return canonicalJson({
    roomCode: input.roomCode?.trim().toUpperCase() ?? null,
    settings: input.settings ?? {}
  });
}

export class RoomCreateReceiptLedger {
  readonly #entries = new Map<string, StoredReceipt>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: RoomCreateReceiptLedgerOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.#ttlMs) ||
      this.#ttlMs <= 0 ||
      !Number.isSafeInteger(this.#maxEntries) ||
      this.#maxEntries <= 0
    ) {
      throw new TypeError("Invalid room create receipt ledger options.");
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  lookup(input: RoomCreateReceiptKey): RoomCreateReceiptLookup {
    const nowMs = this.#readNow();
    this.#cleanup(nowMs);
    const stored = this.#entries.get(entryKey(input));
    if (stored === undefined) return { kind: "miss" };
    if (stored.payload !== payloadKey(input)) {
      return { kind: "request_id_reused" };
    }
    return { kind: "replay", receipt: stored.receipt };
  }

  record(
    input: RoomCreateReceiptKey,
    receipt: RoomCreateReceipt
  ): void {
    const nowMs = this.#readNow();
    this.#cleanup(nowMs);
    const key = entryKey(input);
    const payload = payloadKey(input);
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (
        existing.payload === payload &&
        existing.receipt.roomId === receipt.roomId &&
        existing.receipt.revision === receipt.revision
      ) {
        return;
      }
      throw new Error("ROOM_CREATE_REQUEST_ID_REUSED");
    }
    while (this.#entries.size >= this.#maxEntries) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.#entries.delete(oldestKey);
    }
    const expiresAtMs = nowMs + this.#ttlMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw new RangeError("Room create receipt expiry is out of range.");
    }
    this.#entries.set(key, {
      payload,
      receipt: Object.freeze({ ...receipt }),
      expiresAtMs
    });
  }

  cleanupExpired(atMs: number = this.#readNow()): number {
    if (!Number.isSafeInteger(atMs) || atMs < 0) {
      throw new RangeError("Invalid room create receipt cleanup timestamp.");
    }
    return this.#cleanup(atMs);
  }

  #cleanup(atMs: number): number {
    let removed = 0;
    for (const [key, stored] of this.#entries) {
      if (atMs < stored.expiresAtMs) continue;
      this.#entries.delete(key);
      removed += 1;
    }
    return removed;
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Room create receipt clock returned an invalid time.");
    }
    return value;
  }
}
