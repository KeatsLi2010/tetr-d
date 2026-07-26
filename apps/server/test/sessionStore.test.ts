import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionStore,
  normalizeGuestDisplayName
} from "../src/auth/sessionStore.ts";
import {
  createResumeToken,
  digestResumeToken,
  isResumeToken
} from "../src/auth/token.ts";

const HMAC_KEY = Buffer.alloc(32, 0x5a);

function deterministicToken(byte: number): string {
  return createResumeToken(() => Buffer.alloc(32, byte));
}

function store(options: {
  now?: () => number;
  tokenFactory?: () => string;
  sessionTtlMs?: number;
  maxSessions?: number;
} = {}): SessionStore {
  let sessionNumber = 0;
  let playerNumber = 0;
  return new SessionStore({
    hmacKey: HMAC_KEY,
    now: options.now ?? (() => 1_000),
    ...(options.tokenFactory === undefined
      ? {}
      : { tokenFactory: options.tokenFactory }),
    ...(options.sessionTtlMs === undefined
      ? {}
      : { sessionTtlMs: options.sessionTtlMs }),
    ...(options.maxSessions === undefined
      ? {}
      : { maxSessions: options.maxSessions }),
    sessionIdFactory: () => `session-${++sessionNumber}`,
    playerIdFactory: () => `player-${++playerNumber}`
  });
}

test("resume tokens are opaque 256-bit values with keyed digests", () => {
  const token = deterministicToken(7);
  assert.equal(isResumeToken(token), true);
  assert.match(token, /^rt1\.[A-Za-z0-9_-]{43}$/);

  const digest = digestResumeToken(token, HMAC_KEY);
  assert.notEqual(digest, token);
  assert.equal(digest, digestResumeToken(token, HMAC_KEY));
  assert.notEqual(digest, digestResumeToken(token, Buffer.alloc(32, 8)));
});

test("guest creation normalizes NFC and never exposes a token digest", () => {
  const sessions = store({ tokenFactory: () => deterministicToken(1) });
  const issued = sessions.createGuest({
    displayName: "Cafe\u0301",
    connectionId: "connection-1"
  });

  assert.equal(issued.session.displayName, "Café");
  assert.equal(issued.session.connectionGeneration, 0);
  assert.equal(issued.session.activeConnectionId, "connection-1");
  assert.equal("tokenDigest" in issued.session, false);
  assert.equal(
    JSON.stringify(issued.session).includes(issued.resumeToken),
    false
  );
  assert.deepEqual(
    sessions.getByPlayerId(issued.session.playerId),
    issued.session
  );
});

test("display names reject padding, controls, format controls and bad lengths", () => {
  assert.equal(normalizeGuestDisplayName("玩家 One"), "玩家 One");
  for (const value of [
    "",
    " padded",
    "padded ",
    "line\nbreak",
    "bidi\u202Ename",
    "zero\u200Bwidth",
    "x".repeat(25),
    "\ud800"
  ]) {
    assert.throws(() => normalizeGuestDisplayName(value), TypeError);
  }
  assert.throws(() => normalizeGuestDisplayName(null), TypeError);
});

test("a resume token is consumed once and rotates connection generation", () => {
  const tokens = [deterministicToken(1), deterministicToken(2)];
  const sessions = store({ tokenFactory: () => tokens.shift()! });
  const issued = sessions.createGuest({
    displayName: "Guest",
    connectionId: "connection-old"
  });

  const resumed = sessions.resume({
    resumeToken: issued.resumeToken,
    newConnectionId: "connection-new"
  });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.session.sessionId, issued.session.sessionId);
  assert.equal(resumed.session.playerId, issued.session.playerId);
  assert.equal(resumed.session.connectionGeneration, 1);
  assert.equal(resumed.replacedConnectionId, "connection-old");
  assert.notEqual(resumed.resumeToken, issued.resumeToken);

  assert.deepEqual(
    sessions.resume({
      resumeToken: issued.resumeToken,
      newConnectionId: "connection-attacker"
    }),
    { ok: false, reason: "invalid_or_expired" }
  );
});

test("concurrent attempts with one token have exactly one winner", async () => {
  const tokens = [
    deterministicToken(1),
    deterministicToken(2),
    deterministicToken(3)
  ];
  const sessions = store({ tokenFactory: () => tokens.shift()! });
  const issued = sessions.createGuest({
    displayName: "Guest",
    connectionId: "connection-old"
  });

  const results = await Promise.all([
    Promise.resolve().then(() =>
      sessions.resume({
        resumeToken: issued.resumeToken,
        newConnectionId: "connection-a"
      })
    ),
    Promise.resolve().then(() =>
      sessions.resume({
        resumeToken: issued.resumeToken,
        newConnectionId: "connection-b"
      })
    )
  ]);

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
});

test("connection generation fences replaced and stale sockets", () => {
  const tokens = [deterministicToken(1), deterministicToken(2)];
  const sessions = store({ tokenFactory: () => tokens.shift()! });
  const issued = sessions.createGuest({
    displayName: "Guest",
    connectionId: "connection-old"
  });
  const resumed = sessions.resume({
    resumeToken: issued.resumeToken,
    newConnectionId: "connection-new"
  });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;

  assert.equal(
    sessions.isCurrentConnection(
      issued.session.sessionId,
      "connection-old",
      0
    ),
    false
  );
  assert.equal(
    sessions.isCurrentConnection(
      issued.session.sessionId,
      "connection-new",
      1
    ),
    true
  );
  assert.equal(
    sessions.releaseConnection(
      issued.session.sessionId,
      "connection-old",
      0
    ),
    false
  );
  assert.equal(
    sessions.releaseConnection(
      issued.session.sessionId,
      "connection-new",
      1
    ),
    true
  );
  assert.equal(
    sessions.getBySessionId(issued.session.sessionId)?.activeConnectionId,
    null
  );
});

test("a session can bind to only one room at a time", () => {
  const sessions = store();
  const issued = sessions.createGuest({
    displayName: "Guest",
    connectionId: "connection-1"
  });
  const sessionId = issued.session.sessionId;

  assert.equal(sessions.bindRoom(sessionId, "room-one"), true);
  assert.equal(sessions.getBySessionId(sessionId)?.roomId, "room-one");
  assert.equal(sessions.bindRoom(sessionId, "room-two"), false);
  assert.equal(sessions.clearRoom(sessionId, "room-two"), false);
  assert.equal(sessions.clearRoom(sessionId, "room-one"), true);
  assert.equal(sessions.getBySessionId(sessionId)?.roomId, null);
});

test("expiry invalidates both identity lookup and resume token", () => {
  let nowMs = 1_000;
  const sessions = store({
    now: () => nowMs,
    sessionTtlMs: 500,
    tokenFactory: () => deterministicToken(1)
  });
  const issued = sessions.createGuest({
    displayName: "Guest",
    connectionId: "connection-1"
  });

  nowMs = 1_500;
  assert.deepEqual(
    sessions.resume({
      resumeToken: issued.resumeToken,
      newConnectionId: "connection-2"
    }),
    { ok: false, reason: "invalid_or_expired" }
  );
  assert.equal(sessions.getBySessionId(issued.session.sessionId), null);
  assert.equal(sessions.size, 0);
});

test("cleanup, revocation and capacity keep token indexes consistent", () => {
  let nowMs = 1_000;
  let tokenByte = 1;
  const sessions = store({
    now: () => nowMs,
    sessionTtlMs: 500,
    maxSessions: 1,
    tokenFactory: () => deterministicToken(tokenByte++)
  });
  const first = sessions.createGuest({
    displayName: "First",
    connectionId: "connection-1"
  });
  assert.throws(
    () =>
      sessions.createGuest({
        displayName: "Second",
        connectionId: "connection-2"
      }),
    /SESSION_CAPACITY_REACHED/
  );

  assert.equal(sessions.revoke(first.session.sessionId), true);
  assert.equal(sessions.revoke(first.session.sessionId), false);
  assert.deepEqual(
    sessions.resume({
      resumeToken: first.resumeToken,
      newConnectionId: "connection-3"
    }),
    { ok: false, reason: "invalid_or_expired" }
  );

  sessions.createGuest({
    displayName: "Second",
    connectionId: "connection-2"
  });
  nowMs = 1_500;
  assert.equal(sessions.cleanupExpired(), 1);
  assert.equal(sessions.size, 0);
});
