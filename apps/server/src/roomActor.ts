import { transitionRoom } from "../../../packages/room-core/src/room.ts";
import type {
  PublicRoomPlayer,
  RoomCommand,
  RoomEffect,
  RoomErrorCode,
  RoomSettings,
  RoomState,
  RoomTransition,
  SeatIndex
} from "../../../packages/room-core/src/model.ts";
import { mapRoomUserCommand } from "./roomUserCommandMapper.ts";

export interface RoomActorPrincipal {
  readonly sessionId: string;
  readonly player: PublicRoomPlayer;
  readonly connectionId: string;
  readonly connectionGeneration: number;
}

export type IsRoomActorPrincipalCurrent = (
  principal: RoomActorPrincipal
) => boolean;

interface VersionedUserCommand {
  readonly requestId: string;
  readonly expectedRevision: number;
}

export type RoomUserCommand =
  | {
      readonly type: "member.join";
      readonly requestId: string;
      readonly participation: "player" | "spectator";
      readonly preferredSeat?: SeatIndex;
    }
  | (VersionedUserCommand & { readonly type: "member.leave" })
  | (VersionedUserCommand & {
      readonly type: "seat.set";
      readonly seat: SeatIndex | null;
    })
  | (VersionedUserCommand & {
      readonly type: "ready.set";
      readonly ready: boolean;
    })
  | (VersionedUserCommand & {
      readonly type: "settings.update";
      readonly patch: Partial<RoomSettings>;
    })
  | (VersionedUserCommand & {
      readonly type: "host.transfer";
      readonly targetPlayerId: string;
    })
  | (VersionedUserCommand & {
      readonly type: "member.kick";
      readonly targetPlayerId: string;
    })
  | (VersionedUserCommand & {
      readonly type: "series.rematch";
      readonly accepted: boolean;
    })
  | (VersionedUserCommand & { readonly type: "room.close" });

type WithoutTime<Command> = Command extends { readonly atMs: number }
  ? Omit<Command, "atMs">
  : never;

type SystemCommandType =
  | "connection.lost"
  | "connection.resumed"
  | "connection.replace"
  | "timer.reconnect_elapsed"
  | "timer.countdown_elapsed"
  | "match.finished"
  | "timer.room_expired"
  | "admin.close";

export type RoomSystemCommand = WithoutTime<
  Extract<RoomCommand, { readonly type: SystemCommandType }>
>;

export type RoomCommandReceipt =
  | { readonly kind: "committed"; readonly revision: number }
  | {
      readonly kind: "rejected";
      readonly code: RoomErrorCode;
      readonly currentRevision: number;
    }
  | { readonly kind: "ignored" };

export interface RoomDispatchResult {
  readonly receipt: RoomCommandReceipt;
  readonly state: RoomState;
  readonly effects: readonly RoomEffect[];
  readonly replayed: boolean;
}

export interface RoomActorOptions {
  readonly idempotencyTtlMs?: number;
  readonly maxIdempotencyEntriesPerActor?: number;
  readonly now?: () => number;
  readonly isPrincipalCurrent?: IsRoomActorPrincipalCurrent;
}

interface IdempotencyEntry {
  readonly sessionId: string;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly receipt: RoomCommandReceipt;
  readonly expiresAtMs: number;
}

const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_IDEMPOTENCY_ENTRIES = 256;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function fingerprintRoomUserCommand(command: RoomUserCommand): string {
  return canonicalJson(command);
}

function receiptFor(transition: RoomTransition): RoomCommandReceipt {
  if (transition.kind === "committed") {
    return { kind: "committed", revision: transition.state.revision };
  }
  if (transition.kind === "rejected") {
    return {
      kind: "rejected",
      code: transition.code,
      currentRevision: transition.currentRevision
    };
  }
  return { kind: "ignored" };
}

export class RoomActor {
  #state: RoomState;
  #tail: Promise<void> = Promise.resolve();
  readonly #bySession = new Map<string, Map<string, IdempotencyEntry>>();
  readonly #order = new Map<IdempotencyEntry, true>();
  readonly #idempotencyTtlMs: number;
  readonly #maxIdempotencyEntries: number;
  readonly #now: () => number;
  readonly #isPrincipalCurrent: IsRoomActorPrincipalCurrent;

  constructor(initialState: RoomState, options: RoomActorOptions = {}) {
    this.#state = initialState;
    this.#idempotencyTtlMs =
      options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.#maxIdempotencyEntries =
      options.maxIdempotencyEntriesPerActor ??
      DEFAULT_MAX_IDEMPOTENCY_ENTRIES;
    this.#now = options.now ?? Date.now;
    this.#isPrincipalCurrent = options.isPrincipalCurrent ?? (() => true);
    if (
      !Number.isSafeInteger(this.#idempotencyTtlMs) ||
      this.#idempotencyTtlMs <= 0 ||
      !Number.isSafeInteger(this.#maxIdempotencyEntries) ||
      this.#maxIdempotencyEntries <= 0 ||
      typeof this.#isPrincipalCurrent !== "function"
    ) {
      throw new TypeError("Invalid room actor options.");
    }
  }

  get snapshot(): RoomState {
    return this.#state;
  }

  dispatchUser(
    principal: RoomActorPrincipal,
    command: RoomUserCommand
  ): Promise<RoomDispatchResult> {
    return this.#enqueue(() => this.#applyUser(principal, command));
  }

  dispatchSystem(command: RoomSystemCommand): Promise<RoomDispatchResult> {
    return this.#enqueue(() => {
      const atMs = this.#trustedNow();
      return this.#applyTransition({ ...command, atMs } as RoomCommand, false);
    });
  }

  #enqueue(work: () => RoomDispatchResult): Promise<RoomDispatchResult> {
    const result = this.#tail.then(work);
    this.#tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  #applyUser(
    principal: RoomActorPrincipal,
    command: RoomUserCommand
  ): RoomDispatchResult {
    if (!this.#principalIsCurrent(principal)) return this.#ignored();
    const nowMs = this.#trustedNow();
    this.#prune(nowMs);
    if (!REQUEST_ID.test(command.requestId)) {
      return this.#rejected("INVALID_COMMAND");
    }

    const sessionEntries = this.#bySession.get(principal.sessionId);
    const cached = sessionEntries?.get(command.requestId);
    const fingerprint = fingerprintRoomUserCommand(command);
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) {
        return this.#rejected("REQUEST_ID_REUSED");
      }
      this.#touch(cached);
      return {
        receipt: cached.receipt,
        state: this.#state,
        effects: [],
        replayed: true
      };
    }

    const result = this.#applyTransition(
      mapRoomUserCommand(principal, command, nowMs),
      false
    );
    this.#cache({
      sessionId: principal.sessionId,
      requestId: command.requestId,
      fingerprint,
      receipt: result.receipt,
      expiresAtMs: nowMs + this.#idempotencyTtlMs
    });
    return result;
  }

  #applyTransition(command: RoomCommand, replayed: boolean): RoomDispatchResult {
    const transition = transitionRoom(this.#state, command);
    if (transition.kind === "committed") this.#state = transition.state;
    return {
      receipt: receiptFor(transition),
      state: this.#state,
      effects: transition.kind === "committed" ? transition.effects : [],
      replayed
    };
  }

  #rejected(code: RoomErrorCode): RoomDispatchResult {
    return {
      receipt: {
        kind: "rejected",
        code,
        currentRevision: this.#state.revision
      },
      state: this.#state,
      effects: [],
      replayed: false
    };
  }

  #ignored(): RoomDispatchResult {
    return {
      receipt: { kind: "ignored" },
      state: this.#state,
      effects: [],
      replayed: false
    };
  }

  #principalIsCurrent(principal: RoomActorPrincipal): boolean {
    try {
      return this.#isPrincipalCurrent(principal) === true;
    } catch {
      return false;
    }
  }

  #trustedNow(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Room actor clock returned an invalid timestamp.");
    }
    return Math.max(value, this.#state.updatedAtMs);
  }

  #cache(entry: IdempotencyEntry): void {
    let entries = this.#bySession.get(entry.sessionId);
    if (entries === undefined) {
      entries = new Map();
      this.#bySession.set(entry.sessionId, entries);
    }
    entries.set(entry.requestId, entry);
    this.#order.set(entry, true);
    while (this.#order.size > this.#maxIdempotencyEntries) {
      const oldest = this.#order.keys().next().value;
      if (oldest === undefined) break;
      this.#remove(oldest);
    }
  }

  #touch(entry: IdempotencyEntry): void {
    this.#order.delete(entry);
    this.#order.set(entry, true);
  }

  #prune(nowMs: number): void {
    for (const entry of this.#order.keys()) {
      if (entry.expiresAtMs > nowMs) continue;
      this.#remove(entry);
    }
  }

  #remove(entry: IdempotencyEntry): void {
    this.#order.delete(entry);
    const entries = this.#bySession.get(entry.sessionId);
    entries?.delete(entry.requestId);
    if (entries?.size === 0) this.#bySession.delete(entry.sessionId);
  }
}
