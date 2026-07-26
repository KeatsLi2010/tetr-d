import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectionRateLimiter
} from "../src/gateway/rateLimiter.ts";
import type {
  ConnectionRateLimiterOptions
} from "../src/gateway/rateLimiter.ts";

function setup(
  options: Omit<ConnectionRateLimiterOptions, "now"> = {}
): {
  readonly limiter: ConnectionRateLimiter;
  setNow(value: number): void;
} {
  let nowMs = 1_000;
  return {
    limiter: new ConnectionRateLimiter({
      ...options,
      now: () => nowMs
    }),
    setNow(value) {
      nowMs = value;
    }
  };
}

const SMALL_QUOTAS = {
  general: { capacity: 2, refillPerSecond: 1 },
  "match.input": { capacity: 3, refillPerSecond: 2 }
} as const;

test("general and match input messages use independent quotas", () => {
  const { limiter } = setup({ quotas: SMALL_QUOTAS });

  assert.equal(limiter.consume("connection-a", "general").allowed, true);
  assert.equal(limiter.consume("connection-a", "general").allowed, true);
  assert.deepEqual(limiter.consume("connection-a", "general"), {
    allowed: false,
    remaining: 0,
    retryAfterMs: 1_000,
    reason: "quota"
  });

  assert.equal(limiter.consume("connection-a", "match.input").allowed, true);
  assert.equal(limiter.consume("connection-a", "match.input").allowed, true);
  assert.equal(limiter.consume("connection-a", "match.input").allowed, true);
  assert.deepEqual(limiter.consume("connection-a", "match.input"), {
    allowed: false,
    remaining: 0,
    retryAfterMs: 500,
    reason: "quota"
  });
});

test("token buckets refill using the injected clock", () => {
  const context = setup({ quotas: SMALL_QUOTAS });
  context.limiter.consume("connection-a", "general");
  context.limiter.consume("connection-a", "general");

  context.setNow(1_500);
  assert.deepEqual(context.limiter.consume("connection-a", "general"), {
    allowed: false,
    remaining: 0,
    retryAfterMs: 500,
    reason: "quota"
  });

  context.setNow(2_000);
  assert.deepEqual(context.limiter.consume("connection-a", "general"), {
    allowed: true,
    remaining: 0,
    retryAfterMs: 0,
    reason: null
  });
});

test("connections never share bucket state", () => {
  const { limiter } = setup({ quotas: SMALL_QUOTAS });
  limiter.consume("connection-a", "general");
  limiter.consume("connection-a", "general");

  assert.equal(limiter.consume("connection-a", "general").allowed, false);
  assert.equal(limiter.consume("connection-b", "general").allowed, true);
  assert.equal(limiter.size, 2);
});

test("the hard connection cap fails closed until state is removed", () => {
  const { limiter } = setup({
    quotas: SMALL_QUOTAS,
    maxConnections: 2,
    idleTtlMs: 1_000
  });
  limiter.consume("connection-a", "general");
  limiter.consume("connection-b", "general");

  assert.deepEqual(limiter.consume("connection-c", "general"), {
    allowed: false,
    remaining: 0,
    retryAfterMs: null,
    reason: "capacity"
  });
  assert.equal(limiter.size, 2);
  assert.equal(limiter.remove("connection-a"), true);
  assert.equal(limiter.remove("connection-a"), false);
  assert.equal(limiter.consume("connection-c", "general").allowed, true);
  assert.equal(limiter.size, 2);
});

test("explicit cleanup removes only idle connections", () => {
  const context = setup({
    quotas: SMALL_QUOTAS,
    idleTtlMs: 100
  });
  context.limiter.consume("connection-idle", "general");
  context.limiter.consume("connection-active", "general");

  context.setNow(1_050);
  context.limiter.consume("connection-active", "general");
  context.setNow(1_100);

  assert.equal(context.limiter.cleanupIdle(), 1);
  assert.equal(context.limiter.size, 1);
  assert.equal(context.limiter.remove("connection-idle"), false);
  assert.equal(context.limiter.remove("connection-active"), true);
});

test("consume performs bounded opportunistic cleanup", () => {
  const context = setup({
    quotas: SMALL_QUOTAS,
    idleTtlMs: 100,
    cleanupEvery: 1
  });
  context.limiter.consume("connection-old", "general");
  context.setNow(1_100);
  context.limiter.consume("connection-new", "general");

  assert.equal(context.limiter.size, 1);
  assert.equal(context.limiter.remove("connection-old"), false);
});

test("a backwards clock cannot refill a depleted bucket", () => {
  const context = setup({ quotas: SMALL_QUOTAS });
  context.limiter.consume("connection-a", "general");
  context.limiter.consume("connection-a", "general");

  context.setNow(500);
  assert.deepEqual(context.limiter.consume("connection-a", "general"), {
    allowed: false,
    remaining: 0,
    retryAfterMs: 1_000,
    reason: "quota"
  });
});

test("invalid options, identifiers and clocks are rejected", () => {
  assert.throws(
    () => new ConnectionRateLimiter({ maxConnections: 0 }),
    TypeError
  );
  assert.throws(
    () =>
      new ConnectionRateLimiter({
        quotas: {
          general: { capacity: 1, refillPerSecond: 0 }
        }
      }),
    TypeError
  );

  const context = setup();
  assert.throws(
    () => context.limiter.consume("__proto__", "general"),
    TypeError
  );
  context.setNow(-1);
  assert.throws(
    () => context.limiter.consume("connection-a", "general"),
    RangeError
  );
});
