const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

export interface FixedStepClock {
  nowNs(): bigint;
}

export interface FixedStepScheduler {
  schedule(delayMs: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
}

export type FixedStepLoopState =
  "idle" | "running" | "paused" | "stopped" | "closed";

export interface FixedStepOverloadEvent {
  readonly kind: "entered" | "recovered";
  readonly serverFrame: number;
  readonly targetFrame: number;
  readonly behindFrames: number;
}

export interface FixedStepErrorContext {
  readonly serverFrame: number;
  readonly attemptedFrame: number;
}

export interface FixedStepLoopOptions {
  readonly tickRateHz: number;
  readonly maxCatchUpSteps: number;
  readonly step: (serverFrame: number) => void;
  readonly clock?: FixedStepClock;
  readonly scheduler?: FixedStepScheduler;
  readonly onOverloadChange?: (event: FixedStepOverloadEvent) => void;
  /** Retry preserves the frame; a retryable step must be transactional. */
  readonly onStepError?: (
    error: unknown,
    context: FixedStepErrorContext
  ) => "retry" | "stop";
  readonly onError?: (error: unknown) => void;
}

type NodeWake =
  | { readonly kind: "immediate"; readonly handle: NodeJS.Immediate }
  | { readonly kind: "timeout"; readonly handle: NodeJS.Timeout };

const monotonicClock: FixedStepClock = Object.freeze({
  nowNs: () => process.hrtime.bigint()
});

const nodeScheduler: FixedStepScheduler = Object.freeze({
  schedule(delayMs: number, callback: () => void): NodeWake {
    if (delayMs <= 0) {
      const handle = setImmediate(callback);
      handle.unref();
      return { kind: "immediate", handle };
    }
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return { kind: "timeout", handle };
  },
  cancel(value: unknown): void {
    const wake = value as NodeWake;
    if (wake.kind === "immediate") clearImmediate(wake.handle);
    else clearTimeout(wake.handle);
  }
});

function ceilDivide(dividend: bigint, divisor: bigint): bigint {
  return (dividend + divisor - 1n) / divisor;
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

export class FixedStepLoop {
  readonly #tickRateHz: number;
  readonly #tickRate: bigint;
  readonly #maxCatchUpSteps: number;
  readonly #step: FixedStepLoopOptions["step"];
  readonly #clock: FixedStepClock;
  readonly #scheduler: FixedStepScheduler;
  readonly #onOverloadChange: (event: FixedStepOverloadEvent) => void;
  readonly #onStepError: NonNullable<FixedStepLoopOptions["onStepError"]>;
  readonly #onError: (error: unknown) => void;
  #state: FixedStepLoopState = "idle";
  #serverFrame = 0;
  #epochNs = 0n;
  #lastNowNs = 0n;
  #pausedAtNs = 0n;
  #wake: unknown | null = null;
  #wakeGeneration = 0;
  #overloaded = false;

  constructor(options: FixedStepLoopOptions) {
    this.#tickRateHz = validatePositiveInteger(options.tickRateHz, "tickRateHz");
    this.#tickRate = BigInt(this.#tickRateHz);
    this.#maxCatchUpSteps = validatePositiveInteger(
      options.maxCatchUpSteps, "maxCatchUpSteps"
    );
    this.#step = options.step;
    this.#clock = options.clock ?? monotonicClock;
    this.#scheduler = options.scheduler ?? nodeScheduler;
    this.#onOverloadChange =
      options.onOverloadChange ?? (() => undefined);
    this.#onStepError = options.onStepError ?? (() => "stop");
    this.#onError = options.onError ?? (() => undefined);
  }

  get state(): FixedStepLoopState { return this.#state; }

  get serverFrame(): number { return this.#serverFrame; }

  get tickRateHz(): number { return this.#tickRateHz; }

  get overloaded(): boolean { return this.#overloaded; }

  start(): boolean {
    if (this.#state !== "idle") return false;
    try {
      const nowNs = this.#readNow();
      this.#epochNs = nowNs;
      this.#lastNowNs = nowNs;
      this.#state = "running";
      this.#scheduleNext(nowNs, 0);
      return true;
    } catch (error) {
      this.#halt(error);
      return false;
    }
  }

  pause(): boolean {
    if (this.#state !== "running") return false;
    try {
      this.#pausedAtNs = this.#readNow();
      this.#state = "paused";
      this.#cancelWake();
      return true;
    } catch (error) {
      this.#halt(error);
      return false;
    }
  }

  resume(): boolean {
    if (this.#state !== "paused") return false;
    try {
      const nowNs = this.#readNow();
      this.#epochNs += nowNs - this.#pausedAtNs;
      this.#lastNowNs = nowNs;
      this.#state = "running";
      this.#scheduleNext(nowNs, this.#serverFrame);
      return true;
    } catch (error) {
      this.#halt(error);
      return false;
    }
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#cancelWake();
  }

  #pump(generation: number): void {
    if (this.#state !== "running" || generation !== this.#wakeGeneration) return;
    this.#wake = null;
    try {
      const nowNs = this.#readNow();
      const targetFrame = this.#targetFrame(nowNs);
      const behindFrames = targetFrame - this.#serverFrame;
      this.#updateOverload(targetFrame, behindFrames);
      const batchSize = Math.min(behindFrames, this.#maxCatchUpSteps);
      for (let index = 0; index < batchSize; index += 1) {
        if (this.#state !== "running") return;
        const attemptedFrame = this.#serverFrame + 1;
        try {
          this.#step(attemptedFrame);
          this.#serverFrame = attemptedFrame;
        } catch (error) {
          if (this.#stepFailureAction(error, attemptedFrame) === "stop") {
            this.#halt(error);
            return;
          }
          this.#schedule(0);
          return;
        }
      }
      const afterNs = this.#readNow();
      const afterTarget = this.#targetFrame(afterNs);
      const remaining = afterTarget - this.#serverFrame;
      this.#updateOverload(afterTarget, remaining);
      this.#scheduleNext(afterNs, afterTarget);
    } catch (error) {
      this.#halt(error);
    }
  }

  #targetFrame(nowNs: bigint): number {
    const frame = ((nowNs - this.#epochNs) * this.#tickRate) /
      NANOSECONDS_PER_SECOND;
    if (frame > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("Fixed-step frame exceeded safe integer range.");
    }
    return Number(frame);
  }

  #scheduleNext(nowNs: bigint, targetFrame: number): void {
    if (targetFrame > this.#serverFrame) {
      this.#schedule(0);
      return;
    }
    const nextFrame = BigInt(this.#serverFrame + 1);
    const deadlineNs = this.#epochNs + ceilDivide(
      nextFrame * NANOSECONDS_PER_SECOND, this.#tickRate
    );
    const remainingNs =
      deadlineNs > nowNs ? deadlineNs - nowNs : 0n;
    const delayMs = Number(ceilDivide(remainingNs, NANOSECONDS_PER_MILLISECOND));
    this.#schedule(delayMs);
  }

  #schedule(delayMs: number): void {
    if (this.#state !== "running") return;
    const generation = ++this.#wakeGeneration;
    this.#wake = this.#scheduler.schedule(delayMs, () => {
      this.#pump(generation);
    });
  }

  #cancelWake(): void {
    this.#wakeGeneration += 1;
    const wake = this.#wake;
    this.#wake = null;
    if (wake !== null) this.#scheduler.cancel(wake);
  }

  #updateOverload(targetFrame: number, behindFrames: number): void {
    if (!this.#overloaded && behindFrames <= this.#maxCatchUpSteps) return;
    if (this.#overloaded && behindFrames !== 0) return;
    this.#overloaded = !this.#overloaded;
    try {
      this.#onOverloadChange({
        kind: this.#overloaded ? "entered" : "recovered",
        serverFrame: this.#serverFrame,
        targetFrame,
        behindFrames
      });
    } catch (error) {
      this.#report(error);
    }
  }

  #stepFailureAction(error: unknown, attemptedFrame: number): "retry" | "stop" {
    try {
      return this.#onStepError(error, {
        serverFrame: this.#serverFrame,
        attemptedFrame
      }) === "retry"
        ? "retry"
        : "stop";
    } catch (handlerError) {
      this.#report(handlerError);
      return "stop";
    }
  }

  #readNow(): bigint {
    const nowNs = this.#clock.nowNs();
    if (nowNs < 0n || nowNs < this.#lastNowNs) {
      throw new RangeError("Fixed-step clock must be monotonic.");
    }
    this.#lastNowNs = nowNs;
    return nowNs;
  }

  #halt(error: unknown): void {
    if (this.#state === "closed" || this.#state === "stopped") return;
    this.#state = "stopped";
    this.#cancelWake();
    this.#report(error);
  }

  #report(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Error reporting is the terminal boundary.
    }
  }
}
