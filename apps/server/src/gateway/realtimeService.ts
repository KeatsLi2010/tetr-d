import type {
  MatchClientMessage,
  ProtocolErrorCode,
  RoomClientMessage,
  ServerMessage
} from "../../../../packages/protocol/src/messages.ts";
import type { PublicPlayer } from "../../../../packages/protocol/src/roomMessages.ts";
import type { GuestSession, SessionStore } from "../auth/sessionStore.ts";
import type {
  ConnectionHub,
  ConnectionIdentity,
  ConnectionTransport
} from "./connectionHub.ts";
import { RoomConnectionDispatchRetrier } from "./roomConnectionDispatchRetrier.ts";
import { RoomMessageService } from "./roomMessageService.ts";
import type { RoomManager } from "../rooms/roomManager.ts";
import type { MatchMessageService } from "../matches/matchMessageService.ts";

export interface AuthenticatedConnection extends ConnectionIdentity {
  readonly player: PublicPlayer;
}

export interface AuthenticationSuccess {
  readonly context: AuthenticatedConnection;
  readonly resumeToken: string;
}

export interface GuestCreationRateLimit {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface RealtimeServiceOptions {
  readonly sessions: SessionStore;
  readonly connections: ConnectionHub;
  readonly rooms: RoomManager;
  readonly matchMessages?: MatchMessageService;
  readonly replayMatchStartForPlayer?: (playerId: string) => void;
  readonly now?: () => number;
  readonly guestCreationRateLimit?: GuestCreationRateLimit;
  readonly onError?: (error: unknown) => void;
}

export type AuthenticatedClientMessage = RoomClientMessage | MatchClientMessage;

const DEFAULT_GUEST_CREATION_RATE_LIMIT: GuestCreationRateLimit =
  Object.freeze({
    capacity: 60,
    refillPerSecond: 2
  });

export class GuestCreationRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Guest creation is temporarily rate limited.");
    this.name = "GuestCreationRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

function validateGuestCreationRateLimit(
  value: GuestCreationRateLimit
): GuestCreationRateLimit {
  if (
    !Number.isSafeInteger(value.capacity) ||
    value.capacity <= 0 ||
    !Number.isFinite(value.refillPerSecond) ||
    value.refillPerSecond <= 0
  ) {
    throw new TypeError("Invalid guest creation rate limit.");
  }
  return Object.freeze({
    capacity: value.capacity,
    refillPerSecond: value.refillPerSecond
  });
}

function contextFor(
  session: GuestSession,
  connectionId: string
): AuthenticatedConnection {
  return Object.freeze({
    sessionId: session.sessionId,
    connectionId,
    connectionGeneration: session.connectionGeneration,
    player: Object.freeze({
      playerId: session.playerId,
      displayName: session.displayName
    })
  });
}

export class RealtimeService {
  readonly #sessions: SessionStore;
  readonly #connections: ConnectionHub;
  readonly #rooms: RoomManager;
  readonly #roomMessages: RoomMessageService;
  readonly #matchMessages: MatchMessageService | null;
  readonly #connectionDispatchRetrier: RoomConnectionDispatchRetrier;
  readonly #onError: (error: unknown) => void;
  readonly #replayMatchStartForPlayer: (
    playerId: string
  ) => void;
  readonly #now: () => number;
  readonly #guestCreationRateLimit: GuestCreationRateLimit;
  #guestCreationTokens: number;
  #guestCreationUpdatedAtMs: number;

  constructor(options: RealtimeServiceOptions) {
    this.#sessions = options.sessions;
    this.#connections = options.connections;
    this.#rooms = options.rooms;
    this.#matchMessages = options.matchMessages ?? null;
    this.#onError = options.onError ?? (() => undefined);
    this.#replayMatchStartForPlayer =
      options.replayMatchStartForPlayer ?? (() => undefined);
    this.#now = options.now ?? Date.now;
    this.#guestCreationRateLimit = validateGuestCreationRateLimit(
      options.guestCreationRateLimit ?? DEFAULT_GUEST_CREATION_RATE_LIMIT
    );
    this.#guestCreationTokens = this.#guestCreationRateLimit.capacity;
    this.#guestCreationUpdatedAtMs = this.#readNow();
    this.#connectionDispatchRetrier =
      new RoomConnectionDispatchRetrier({
        sessions: options.sessions,
        rooms: options.rooms
      });
    this.#roomMessages = new RoomMessageService({
      sessions: options.sessions,
      connections: options.connections,
      rooms: options.rooms,
      connectionDispatchRetrier: this.#connectionDispatchRetrier,
      ...(options.onError === undefined ? {} : { onError: options.onError })
    });
  }

  createGuest(
    connectionId: string,
    transport: ConnectionTransport,
    displayName: string
  ): AuthenticationSuccess {
    this.#consumeGuestCreationToken();
    const issued = this.#sessions.createGuest({ displayName, connectionId });
    const context = contextFor(issued.session, connectionId);
    const bound = this.#connections.bind({
      ...context,
      roomId: null,
      transport
    });
    if (bound.status === "stale") {
      this.#sessions.revoke(issued.session.sessionId);
      throw new Error("New guest connection was rejected as stale.");
    }
    return Object.freeze({ context, resumeToken: issued.resumeToken });
  }

  resumeGuest(
    connectionId: string,
    transport: ConnectionTransport,
    resumeToken: string
  ): AuthenticationSuccess | null {
    const resumed = this.#sessions.resume({
      resumeToken,
      newConnectionId: connectionId
    });
    if (!resumed.ok) return null;
    const context = contextFor(resumed.session, connectionId);
    const bound = this.#connections.bind({
      ...context,
      roomId: resumed.session.roomId,
      transport
    });
    if (bound.status === "stale") {
      throw new Error("Resumed connection was rejected as stale.");
    }
    return Object.freeze({ context, resumeToken: resumed.resumeToken });
  }

  async afterAuthenticated(context: AuthenticatedConnection): Promise<void> {
    const session = this.#currentSession(context);
    if (session === null || session.roomId === null) return;
    const room = this.#rooms.getById(session.roomId);
    if (room === null) {
      this.#roomMessages.leaveSessionRoom(context, session.roomId);
      return;
    }
    const restored =
      await this.#connectionDispatchRetrier.restoreConnection(
        context,
        room.roomId
      );
    if (restored.status === "stopped" || !this.isCurrent(context)) return;
    const result = restored.value;
    if (result !== null) {
      if (result.receipt.kind === "rejected") {
        this.sendError(
          context,
          result.receipt.code,
          `Room resume rejected: ${result.receipt.code}.`,
          false,
          undefined,
          result.receipt.currentRevision
        );
        this.#roomMessages.leaveSessionRoom(context, room.roomId);
        return;
      }
    }
    if (!this.isCurrent(context)) return;
    this.#roomMessages.sendRoomState(context, room.roomId);
    try {
      this.#replayMatchStartForPlayer(context.player.playerId);
    } catch (error) {
      this.#report(error);
    }
  }

  isCurrent(context: AuthenticatedConnection): boolean {
    return this.#sessions.isCurrentConnection(
      context.sessionId,
      context.connectionId,
      context.connectionGeneration
    );
  }

  async handleMessage(
    context: AuthenticatedConnection,
    message: AuthenticatedClientMessage
  ): Promise<void> {
    if (!this.isCurrent(context)) return;
    if (message.type.startsWith("room.")) {
      await this.#roomMessages.handle(context, message as RoomClientMessage);
      return;
    }
    if (this.#matchMessages !== null) {
      this.#matchMessages.handle(context, message as MatchClientMessage);
      return;
    }
    this.sendError(
      context,
      "MESSAGE_INVALID",
      "Match simulation messages are not enabled in this server slice.",
      false,
      message.type === "match.forfeit" ? message.requestId : undefined
    );
  }

  async disconnect(context: AuthenticatedConnection): Promise<void> {
    const session = this.#sessions.getBySessionId(context.sessionId);
    if (
      session === null ||
      !this.#sessions.releaseConnection(
        context.sessionId,
        context.connectionId,
        context.connectionGeneration
      )
    ) {
      return;
    }
    this.#connections.unbind(context);
    if (session.roomId === null) return;
    try {
      await this.#connectionDispatchRetrier.connectionLost(
        context,
        session.roomId
      );
    } catch (error) {
      this.#report(error);
    }
  }

  send(context: AuthenticatedConnection, message: ServerMessage): void {
    this.#connections.send(context, JSON.stringify(message));
  }

  sendError(
    context: AuthenticatedConnection,
    code: ProtocolErrorCode,
    message: string,
    retryable: boolean,
    requestId?: string,
    currentRevision?: number
  ): void {
    this.send(context, {
      type: "error",
      code,
      message,
      retryable,
      ...(requestId === undefined ? {} : { requestId }),
      ...(currentRevision === undefined ? {} : { currentRevision })
    });
  }

  #currentSession(context: AuthenticatedConnection): GuestSession | null {
    if (!this.isCurrent(context)) return null;
    return this.#sessions.getBySessionId(context.sessionId);
  }

  #consumeGuestCreationToken(): void {
    const nowMs = Math.max(this.#readNow(), this.#guestCreationUpdatedAtMs);
    const elapsedMs = nowMs - this.#guestCreationUpdatedAtMs;
    this.#guestCreationTokens = Math.min(
      this.#guestCreationRateLimit.capacity,
      this.#guestCreationTokens +
        (elapsedMs * this.#guestCreationRateLimit.refillPerSecond) / 1_000
    );
    this.#guestCreationUpdatedAtMs = nowMs;
    if (this.#guestCreationTokens >= 1) {
      this.#guestCreationTokens -= 1;
      return;
    }
    const retryAfterMs = Math.max(
      1,
      Math.ceil(
        ((1 - this.#guestCreationTokens) /
          this.#guestCreationRateLimit.refillPerSecond) *
          1_000
      )
    );
    throw new GuestCreationRateLimitError(retryAfterMs);
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        "Realtime service clock returned an invalid timestamp."
      );
    }
    return value;
  }

  #report(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Logging is a terminal boundary.
    }
  }
}
