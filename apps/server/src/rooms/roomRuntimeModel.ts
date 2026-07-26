import type {
  RoomEffect,
  RoomState
} from "../../../../packages/room-core/src/model.ts";
import type {
  RoomScheduler
} from "./roomScheduler.ts";

export const DEFAULT_DISPATCH_QUEUE_CAPACITY = 64;

export interface RoomRuntimeCommit {
  readonly before: RoomState;
  readonly after: RoomState;
  readonly effects: readonly RoomEffect[];
}

export interface RoomRuntimeOptions {
  readonly scheduler?: RoomScheduler;
  readonly matchIdFactory?: () => string;
  readonly now?: () => number;
  readonly timerRetryDelayMs?: number;
  readonly commitRetryBaseMs?: number;
  readonly commitRetryMaxMs?: number;
  readonly dispatchQueueCapacity?: number;
  readonly onCommit?: (
    commit: RoomRuntimeCommit
  ) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export class RoomRuntimeQueueCapacityError extends Error {
  constructor() {
    super("ROOM_RUNTIME_QUEUE_CAPACITY_REACHED");
    this.name = "RoomRuntimeQueueCapacityError";
  }
}
