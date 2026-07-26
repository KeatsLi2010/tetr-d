export type MessageRateTier = "general" | "match.input";

export interface TokenBucketQuota {
  /** Maximum burst size. */
  readonly capacity: number;
  /** Tokens restored per second. */
  readonly refillPerSecond: number;
}

export interface ConnectionRateLimiterOptions {
  readonly now?: () => number;
  readonly quotas?: Partial<Readonly<Record<MessageRateTier, TokenBucketQuota>>>;
  readonly maxConnections?: number;
  readonly idleTtlMs?: number;
  readonly cleanupEvery?: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  /**
   * Zero for an allowed request, the wait for a depleted bucket, and null when
   * no per-connection state could be allocated because the store is full.
   */
  readonly retryAfterMs: number | null;
  readonly reason: "quota" | "capacity" | null;
}

interface BucketState {
  tokens: number;
  updatedAtMs: number;
}

interface ConnectionState {
  lastSeenAtMs: number;
  readonly buckets: Record<MessageRateTier, BucketState>;
}

const SAFE_CONNECTION_ID =
  /^(?!(?:__proto__|prototype|constructor)$)[A-Za-z0-9_.:-]{1,128}$/;

const DEFAULT_QUOTAS: Readonly<Record<MessageRateTier, TokenBucketQuota>> =
  Object.freeze({
    general: Object.freeze({
      capacity: 20,
      refillPerSecond: 10
    }),
    "match.input": Object.freeze({
      capacity: 240,
      refillPerSecond: 120
    })
  });

const DEFAULT_MAX_CONNECTIONS = 10_000;
const DEFAULT_IDLE_TTL_MS = 2 * 60_000;
const DEFAULT_CLEANUP_EVERY = 128;

function validateQuota(quota: TokenBucketQuota): TokenBucketQuota {
  if (
    !Number.isSafeInteger(quota.capacity) ||
    quota.capacity <= 0 ||
    !Number.isFinite(quota.refillPerSecond) ||
    quota.refillPerSecond <= 0
  ) {
    throw new TypeError("Invalid token bucket quota.");
  }
  return Object.freeze({
    capacity: quota.capacity,
    refillPerSecond: quota.refillPerSecond
  });
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

/**
 * In-memory, per-connection token buckets for a single realtime process.
 *
 * The gateway chooses the tier after runtime schema validation. Callers must
 * remove a connection on close; idle cleanup and the hard capacity are backup
 * bounds for missed close events and hostile connection churn.
 */
export class ConnectionRateLimiter {
  readonly #connections = new Map<string, ConnectionState>();
  readonly #quotas: Readonly<Record<MessageRateTier, TokenBucketQuota>>;
  readonly #maxConnections: number;
  readonly #idleTtlMs: number;
  readonly #cleanupEvery: number;
  readonly #now: () => number;
  #operationsSinceCleanup = 0;

  constructor(options: ConnectionRateLimiterOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxConnections = validatePositiveInteger(
      options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      "connection capacity"
    );
    this.#idleTtlMs = validatePositiveInteger(
      options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
      "idle TTL"
    );
    this.#cleanupEvery = validatePositiveInteger(
      options.cleanupEvery ?? DEFAULT_CLEANUP_EVERY,
      "cleanup interval"
    );
    this.#quotas = Object.freeze({
      general: validateQuota(
        options.quotas?.general ?? DEFAULT_QUOTAS.general
      ),
      "match.input": validateQuota(
        options.quotas?.["match.input"] ?? DEFAULT_QUOTAS["match.input"]
      )
    });
  }

  get size(): number {
    return this.#connections.size;
  }

  consume(
    connectionId: string,
    tier: MessageRateTier
  ): RateLimitDecision {
    if (!SAFE_CONNECTION_ID.test(connectionId)) {
      throw new TypeError("Invalid connection ID.");
    }
    const nowMs = this.#readNow();
    this.#operationsSinceCleanup += 1;
    if (this.#operationsSinceCleanup >= this.#cleanupEvery) {
      this.cleanupIdle(nowMs);
      this.#operationsSinceCleanup = 0;
    }

    let state = this.#connections.get(connectionId);
    if (state === undefined) {
      if (this.#connections.size >= this.#maxConnections) {
        this.cleanupIdle(nowMs);
      }
      if (this.#connections.size >= this.#maxConnections) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: null,
          reason: "capacity"
        };
      }
      state = this.#createState(nowMs);
      this.#connections.set(connectionId, state);
    }

    const effectiveNowMs = Math.max(nowMs, state.lastSeenAtMs);
    state.lastSeenAtMs = effectiveNowMs;
    const bucket = state.buckets[tier];
    const quota = this.#quotas[tier];
    this.#refill(bucket, quota, effectiveNowMs);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterMs: 0,
        reason: null
      };
    }

    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(
        1,
        Math.ceil(((1 - bucket.tokens) / quota.refillPerSecond) * 1_000)
      ),
      reason: "quota"
    };
  }

  remove(connectionId: string): boolean {
    return this.#connections.delete(connectionId);
  }

  cleanupIdle(atMs: number = this.#readNow()): number {
    if (!Number.isSafeInteger(atMs) || atMs < 0) {
      throw new RangeError("Invalid cleanup timestamp.");
    }
    let removed = 0;
    for (const [connectionId, state] of this.#connections) {
      if (atMs < state.lastSeenAtMs) continue;
      if (atMs - state.lastSeenAtMs < this.#idleTtlMs) continue;
      this.#connections.delete(connectionId);
      removed += 1;
    }
    return removed;
  }

  #createState(nowMs: number): ConnectionState {
    return {
      lastSeenAtMs: nowMs,
      buckets: {
        general: {
          tokens: this.#quotas.general.capacity,
          updatedAtMs: nowMs
        },
        "match.input": {
          tokens: this.#quotas["match.input"].capacity,
          updatedAtMs: nowMs
        }
      }
    };
  }

  #refill(
    bucket: BucketState,
    quota: TokenBucketQuota,
    nowMs: number
  ): void {
    const elapsedMs = nowMs - bucket.updatedAtMs;
    if (elapsedMs <= 0) return;
    bucket.tokens = Math.min(
      quota.capacity,
      bucket.tokens + (elapsedMs * quota.refillPerSecond) / 1_000
    );
    bucket.updatedAtMs = nowMs;
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Rate limiter clock returned an invalid timestamp.");
    }
    return value;
  }
}
