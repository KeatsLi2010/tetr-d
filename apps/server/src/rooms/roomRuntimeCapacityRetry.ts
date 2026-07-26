import {
  RoomRuntimeQueueCapacityError
} from "./roomRuntime.ts";

export type RoomCapacityRetryResult<Value> =
  | { readonly status: "completed"; readonly value: Value }
  | { readonly status: "stopped" };

export interface RoomCapacityRetryOptions<Value> {
  readonly attempt: () => Value | PromiseLike<Value>;
  readonly shouldContinue: () => boolean;
  readonly wait?: (delayMs: number) => Promise<void>;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

const DEFAULT_BASE_DELAY_MS = 10;
const DEFAULT_MAX_DELAY_MS = 250;

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function canContinue(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

export async function retryRoomRuntimeCapacity<Value>(
  options: RoomCapacityRetryOptions<Value>
): Promise<RoomCapacityRetryResult<Value>> {
  const wait = options.wait ?? waitFor;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  let delayMs = baseDelayMs;
  while (canContinue(options.shouldContinue)) {
    try {
      return {
        status: "completed",
        value: await options.attempt()
      };
    } catch (error) {
      if (!(error instanceof RoomRuntimeQueueCapacityError)) {
        if (!canContinue(options.shouldContinue)) {
          return { status: "stopped" };
        }
        throw error;
      }
    }
    if (!canContinue(options.shouldContinue)) {
      return { status: "stopped" };
    }
    await wait(delayMs);
    delayMs = Math.min(maxDelayMs, delayMs * 2);
  }
  return { status: "stopped" };
}
