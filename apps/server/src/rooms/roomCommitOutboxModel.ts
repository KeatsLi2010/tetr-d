import type { RoomEffect } from "../../../../packages/room-core/src/model.ts";
import type { RoomRuntimeCommit } from "./roomRuntime.ts";

export interface RoomOutboxCommit {
  readonly roomId: string;
  /** Monotonic commit sequence, unique within one room. */
  readonly revision: number;
  readonly effects: readonly RoomEffect[];
}

export type RoomCommitOutboxInput = RoomOutboxCommit | RoomRuntimeCommit;

export interface RoomEffectDelivery {
  readonly deliveryId: string;
  readonly roomId: string;
  readonly revision: number;
  readonly effectIndex: number;
  readonly attempt: number;
  readonly effect: RoomEffect;
}

export type RoomEffectDeliveryHandler = (
  delivery: RoomEffectDelivery
) => void | Promise<void>;

export interface RoomCommitOutboxScheduler {
  schedule(deadlineMs: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface RoomCommitOutboxOptions {
  readonly handler: RoomEffectDeliveryHandler;
  readonly scheduler?: RoomCommitOutboxScheduler;
  /** Used only when the primary scheduler rejects a retry task. */
  readonly recoveryScheduler?: RoomCommitOutboxScheduler;
  readonly clock?: () => number;
  readonly onError?: (
    error: unknown,
    delivery: RoomEffectDelivery | null
  ) => void;
  readonly capacity?: number;
  /** Maximum unique commits waiting for capacity. */
  readonly waitingCapacity?: number;
  readonly completedRetention?: number;
  readonly baseRetryMs?: number;
  readonly maxRetryMs?: number;
  /** Total delivery attempts per effect. Defaults to unlimited. */
  readonly maxAttempts?: number;
}

export interface PreparedRoomOutboxCommit extends RoomOutboxCommit {
  readonly key: string;
  readonly fingerprint: string;
}

const ROOM_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export class RoomCommitOutboxCapacityError extends Error {
  constructor() {
    super("ROOM_COMMIT_OUTBOX_CAPACITY_REACHED");
    this.name = "RoomCommitOutboxCapacityError";
  }
}

export class RoomCommitOutboxWaitCapacityError extends Error {
  constructor() {
    super("ROOM_COMMIT_OUTBOX_WAIT_CAPACITY_REACHED");
    this.name = "RoomCommitOutboxWaitCapacityError";
  }
}

export class RoomCommitOutboxConflictError extends Error {
  constructor() {
    super("ROOM_COMMIT_OUTBOX_REVISION_CONFLICT");
    this.name = "RoomCommitOutboxConflictError";
  }
}

export class RoomCommitDeliveryExhaustedError extends Error {
  readonly deliveryId: string;

  constructor(deliveryId: string) {
    super(`Room commit delivery exhausted: ${deliveryId}`);
    this.name = "RoomCommitDeliveryExhaustedError";
    this.deliveryId = deliveryId;
  }
}

export class RoomCommitRetryScheduleFailedError extends Error {
  readonly deliveryId: string;

  constructor(deliveryId: string) {
    super(`Room commit retry could not be scheduled: ${deliveryId}`);
    this.name = "RoomCommitRetryScheduleFailedError";
    this.deliveryId = deliveryId;
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function copyEffects(effects: readonly RoomEffect[]): readonly RoomEffect[] {
  return Object.freeze(
    effects.map((effect) => deepFreeze(structuredClone(effect)))
  );
}

function normalizeCommit(input: RoomCommitOutboxInput): RoomOutboxCommit {
  if ("after" in input) {
    /*
     * Control revision intentionally does not advance for presence-only
     * commits. presenceSequence is the unique commit revision for outbox use.
     */
    return {
      roomId: input.after.roomId,
      revision: input.after.presenceSequence,
      effects: input.effects
    };
  }
  return input;
}

export function prepareRoomOutboxCommit(
  input: RoomCommitOutboxInput
): PreparedRoomOutboxCommit {
  const normalized = normalizeCommit(input);
  if (
    !ROOM_ID.test(normalized.roomId) ||
    !Number.isSafeInteger(normalized.revision) ||
    normalized.revision < 1 ||
    !Array.isArray(normalized.effects)
  ) {
    throw new TypeError("Invalid room outbox commit.");
  }
  const effects = copyEffects(normalized.effects);
  return {
    roomId: normalized.roomId,
    revision: normalized.revision,
    effects,
    key: JSON.stringify([normalized.roomId, normalized.revision]),
    fingerprint: JSON.stringify(effects)
  };
}

export function roomEffectDeliveryId(
  roomId: string,
  revision: number,
  effectIndex: number
): string {
  const encodedRoomId = Buffer.from(roomId, "utf8").toString("base64url");
  return `room-effect:${encodedRoomId}:${revision}:${effectIndex}`;
}

export function createDefaultRoomCommitOutboxScheduler(
  clock: () => number
): RoomCommitOutboxScheduler {
  return {
    schedule(deadlineMs, callback) {
      const handle = setTimeout(callback, Math.max(0, deadlineMs - clock()));
      handle.unref();
      return handle;
    },
    cancel(handle) {
      clearTimeout(handle as NodeJS.Timeout);
    }
  };
}
