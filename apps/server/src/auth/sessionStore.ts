import { randomBytes, randomUUID } from "node:crypto";

import {
  createResumeToken,
  digestResumeToken,
  isResumeToken
} from "./token.ts";

const SAFE_SERVER_ID =
  /^(?!(?:__proto__|prototype|constructor)$)[A-Za-z0-9_.:-]{1,128}$/;
const UNSAFE_DISPLAY_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_SESSIONS = 10_000;
const UNIQUE_VALUE_ATTEMPTS = 32;

export interface GuestSession {
  readonly sessionId: string;
  readonly playerId: string;
  readonly displayName: string;
  readonly roomId: string | null;
  readonly activeConnectionId: string | null;
  readonly connectionGeneration: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface IssuedGuestSession {
  readonly session: GuestSession;
  readonly resumeToken: string;
}

export type ResumeGuestSessionResult =
  | {
      readonly ok: true;
      readonly session: GuestSession;
      readonly resumeToken: string;
      readonly replacedConnectionId: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid_or_expired";
    };

export interface SessionStoreOptions {
  readonly hmacKey?: Uint8Array;
  readonly sessionTtlMs?: number;
  readonly maxSessions?: number;
  readonly now?: () => number;
  readonly tokenFactory?: () => string;
  readonly sessionIdFactory?: () => string;
  readonly playerIdFactory?: () => string;
}

export interface CreateGuestInput {
  readonly displayName: string;
  readonly connectionId: string;
}

export interface ResumeGuestInput {
  readonly resumeToken: string;
  readonly newConnectionId: string;
}

interface StoredSession {
  readonly sessionId: string;
  readonly playerId: string;
  readonly displayName: string;
  roomId: string | null;
  activeConnectionId: string | null;
  connectionGeneration: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  tokenDigest: string;
}

export function normalizeGuestDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Display name must be a string.");
  }
  const normalized = value.normalize("NFC");
  const length = [...normalized].length;
  if (
    length < 1 ||
    length > 24 ||
    normalized.trim() !== normalized ||
    UNSAFE_DISPLAY_CHARACTER.test(normalized)
  ) {
    throw new TypeError("Invalid display name.");
  }
  return normalized;
}

function sessionView(session: StoredSession): GuestSession {
  return Object.freeze({
    sessionId: session.sessionId,
    playerId: session.playerId,
    displayName: session.displayName,
    roomId: session.roomId,
    activeConnectionId: session.activeConnectionId,
    connectionGeneration: session.connectionGeneration,
    createdAtMs: session.createdAtMs,
    expiresAtMs: session.expiresAtMs
  });
}

export class SessionStore {
  readonly #sessionsById = new Map<string, StoredSession>();
  readonly #sessionIdByPlayerId = new Map<string, string>();
  readonly #sessionIdByTokenDigest = new Map<string, string>();
  readonly #hmacKey: Uint8Array;
  readonly #sessionTtlMs: number;
  readonly #maxSessions: number;
  readonly #now: () => number;
  readonly #tokenFactory: () => string;
  readonly #sessionIdFactory: () => string;
  readonly #playerIdFactory: () => string;

  constructor(options: SessionStoreOptions = {}) {
    this.#hmacKey = Buffer.from(options.hmacKey ?? randomBytes(32));
    this.#sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#now = options.now ?? Date.now;
    this.#tokenFactory = options.tokenFactory ?? createResumeToken;
    this.#sessionIdFactory =
      options.sessionIdFactory ?? (() => `s_${randomUUID()}`);
    this.#playerIdFactory =
      options.playerIdFactory ?? (() => `p_${randomUUID()}`);

    if (
      this.#hmacKey.byteLength < 32 ||
      !Number.isSafeInteger(this.#sessionTtlMs) ||
      this.#sessionTtlMs <= 0 ||
      !Number.isSafeInteger(this.#maxSessions) ||
      this.#maxSessions <= 0
    ) {
      throw new TypeError("Invalid session store options.");
    }
  }

  get size(): number {
    return this.#sessionsById.size;
  }

  createGuest(input: CreateGuestInput): IssuedGuestSession {
    const nowMs = this.#readNow();
    this.cleanupExpired(nowMs);
    if (this.#sessionsById.size >= this.#maxSessions) {
      throw new Error("SESSION_CAPACITY_REACHED");
    }
    if (!SAFE_SERVER_ID.test(input.connectionId)) {
      throw new TypeError("Invalid connection ID.");
    }

    const displayName = normalizeGuestDisplayName(input.displayName);
    const sessionId = this.#uniqueId(
      this.#sessionIdFactory,
      (value) => this.#sessionsById.has(value)
    );
    const playerId = this.#uniqueId(
      this.#playerIdFactory,
      (value) => this.#sessionIdByPlayerId.has(value)
    );
    const issued = this.#issueToken();
    const session: StoredSession = {
      sessionId,
      playerId,
      displayName,
      roomId: null,
      activeConnectionId: input.connectionId,
      connectionGeneration: 0,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.#sessionTtlMs,
      tokenDigest: issued.digest
    };
    this.#sessionsById.set(sessionId, session);
    this.#sessionIdByPlayerId.set(playerId, sessionId);
    this.#sessionIdByTokenDigest.set(issued.digest, sessionId);
    return { session: sessionView(session), resumeToken: issued.token };
  }

  resume(input: ResumeGuestInput): ResumeGuestSessionResult {
    if (
      !isResumeToken(input.resumeToken) ||
      !SAFE_SERVER_ID.test(input.newConnectionId)
    ) {
      return { ok: false, reason: "invalid_or_expired" };
    }
    const nowMs = this.#readNow();
    const oldDigest = digestResumeToken(input.resumeToken, this.#hmacKey);
    const sessionId = this.#sessionIdByTokenDigest.get(oldDigest);
    if (sessionId === undefined) {
      return { ok: false, reason: "invalid_or_expired" };
    }
    const session = this.#sessionsById.get(sessionId);
    if (
      session === undefined ||
      session.tokenDigest !== oldDigest ||
      nowMs >= session.expiresAtMs
    ) {
      if (session !== undefined && nowMs >= session.expiresAtMs) {
        this.#delete(session);
      } else {
        this.#sessionIdByTokenDigest.delete(oldDigest);
      }
      return { ok: false, reason: "invalid_or_expired" };
    }
    if (session.connectionGeneration >= Number.MAX_SAFE_INTEGER) {
      this.#delete(session);
      return { ok: false, reason: "invalid_or_expired" };
    }

    const issued = this.#issueToken(oldDigest);
    const replacedConnectionId = session.activeConnectionId;

    // No await may be introduced between consuming the old digest and
    // publishing the replacement. This is the single-process CAS boundary.
    this.#sessionIdByTokenDigest.delete(oldDigest);
    session.tokenDigest = issued.digest;
    session.activeConnectionId = input.newConnectionId;
    session.connectionGeneration += 1;
    this.#sessionIdByTokenDigest.set(issued.digest, session.sessionId);

    return {
      ok: true,
      session: sessionView(session),
      resumeToken: issued.token,
      replacedConnectionId
    };
  }

  getBySessionId(sessionId: string): GuestSession | null {
    const session = this.#sessionsById.get(sessionId);
    return this.#currentView(session);
  }

  getByPlayerId(playerId: string): GuestSession | null {
    const sessionId = this.#sessionIdByPlayerId.get(playerId);
    if (sessionId === undefined) return null;
    return this.#currentView(this.#sessionsById.get(sessionId));
  }

  bindRoom(sessionId: string, roomId: string): boolean {
    if (!SAFE_SERVER_ID.test(roomId)) return false;
    const session = this.#sessionsById.get(sessionId);
    if (session === undefined || this.#expired(session, this.#readNow())) {
      if (session !== undefined) this.#delete(session);
      return false;
    }
    if (session.roomId !== null && session.roomId !== roomId) return false;
    session.roomId = roomId;
    return true;
  }

  clearRoom(sessionId: string, expectedRoomId: string): boolean {
    const session = this.#sessionsById.get(sessionId);
    if (session === undefined || session.roomId !== expectedRoomId) return false;
    session.roomId = null;
    return true;
  }

  isCurrentConnection(
    sessionId: string,
    connectionId: string,
    connectionGeneration: number
  ): boolean {
    const session = this.#sessionsById.get(sessionId);
    if (session === undefined || this.#expired(session, this.#readNow())) {
      if (session !== undefined) this.#delete(session);
      return false;
    }
    return (
      session.activeConnectionId === connectionId &&
      session.connectionGeneration === connectionGeneration
    );
  }

  releaseConnection(
    sessionId: string,
    connectionId: string,
    connectionGeneration: number
  ): boolean {
    const session = this.#sessionsById.get(sessionId);
    if (
      session === undefined ||
      session.activeConnectionId !== connectionId ||
      session.connectionGeneration !== connectionGeneration
    ) {
      return false;
    }
    session.activeConnectionId = null;
    return true;
  }

  revoke(sessionId: string): boolean {
    const session = this.#sessionsById.get(sessionId);
    if (session === undefined) return false;
    this.#delete(session);
    return true;
  }

  cleanupExpired(atMs: number = this.#readNow()): number {
    if (!Number.isSafeInteger(atMs) || atMs < 0) {
      throw new RangeError("Invalid cleanup timestamp.");
    }
    let removed = 0;
    for (const session of this.#sessionsById.values()) {
      if (!this.#expired(session, atMs)) continue;
      this.#delete(session);
      removed += 1;
    }
    return removed;
  }

  #currentView(session: StoredSession | undefined): GuestSession | null {
    if (session === undefined) return null;
    if (this.#expired(session, this.#readNow())) {
      this.#delete(session);
      return null;
    }
    return sessionView(session);
  }

  #issueToken(excludedDigest?: string): {
    readonly token: string;
    readonly digest: string;
  } {
    for (let attempt = 0; attempt < UNIQUE_VALUE_ATTEMPTS; attempt += 1) {
      const token = this.#tokenFactory();
      if (!isResumeToken(token)) {
        throw new TypeError("Token factory returned an invalid token.");
      }
      const digest = digestResumeToken(token, this.#hmacKey);
      if (
        digest !== excludedDigest &&
        !this.#sessionIdByTokenDigest.has(digest)
      ) {
        return { token, digest };
      }
    }
    throw new Error("SESSION_TOKEN_COLLISION");
  }

  #uniqueId(
    factory: () => string,
    exists: (value: string) => boolean
  ): string {
    for (let attempt = 0; attempt < UNIQUE_VALUE_ATTEMPTS; attempt += 1) {
      const value = factory();
      if (!SAFE_SERVER_ID.test(value)) {
        throw new TypeError("ID factory returned an invalid value.");
      }
      if (!exists(value)) return value;
    }
    throw new Error("SESSION_ID_COLLISION");
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Session clock returned an invalid timestamp.");
    }
    return value;
  }

  #expired(session: StoredSession, atMs: number): boolean {
    return atMs >= session.expiresAtMs;
  }

  #delete(session: StoredSession): void {
    this.#sessionsById.delete(session.sessionId);
    this.#sessionIdByPlayerId.delete(session.playerId);
    this.#sessionIdByTokenDigest.delete(session.tokenDigest);
  }
}
