import { Buffer } from "node:buffer";

export const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024;

const CLOSE_SUPERSEDED = 4001;
const CLOSE_BACKPRESSURE = 1013;
const CLOSE_SEND_FAILED = 1011;

export interface ConnectionIdentity {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
}

/**
 * The gateway adapter is intentionally narrower than ws.WebSocket.
 * `send` means accepted into the transport buffer, not delivered to the peer.
 */
export interface ConnectionTransport {
  readonly bufferedAmount: number;
  send(payload: string): void;
  close(code: number, reason: string): void;
}

export interface BindConnectionInput extends ConnectionIdentity {
  readonly roomId: string | null;
  readonly transport: ConnectionTransport;
}

export interface BackpressureContext extends ConnectionIdentity {
  readonly roomId: string | null;
  readonly bufferedBytes: number;
  readonly payloadBytes: number;
  readonly maxBufferedBytes: number;
}

export type BackpressureAction = "reject" | "disconnect";

export interface ConnectionHubOptions {
  readonly maxBufferedBytes?: number;
  readonly onBackpressure?: (
    context: BackpressureContext
  ) => BackpressureAction;
}

export type BindConnectionResult =
  | { readonly status: "bound" }
  | { readonly status: "replaced"; readonly replacedConnectionId: string }
  | { readonly status: "already_bound" }
  | { readonly status: "stale" };

export type GuardedMutationResult =
  | { readonly status: "updated" }
  | { readonly status: "no_change" }
  | { readonly status: "not_found" }
  | { readonly status: "stale" };

export type ConnectionSendResult =
  | { readonly status: "accepted"; readonly payloadBytes: number }
  | { readonly status: "not_found" }
  | { readonly status: "stale" }
  | {
      readonly status:
        | "backpressure_rejected"
        | "backpressure_disconnected";
      readonly payloadBytes: number;
      readonly bufferedBytes: number;
    }
  | { readonly status: "send_failed"; readonly payloadBytes: number };

export interface RoomBroadcastEntry {
  readonly sessionId: string;
  readonly result: ConnectionSendResult;
}

export interface RoomBroadcastResult {
  readonly roomId: string;
  readonly attempted: number;
  readonly accepted: number;
  readonly entries: readonly RoomBroadcastEntry[];
}

interface ActiveConnection extends BindConnectionInput {}

function validateId(value: string, name: string): void {
  if (value.length < 1 || value.length > 128 || value.includes("\0")) {
    throw new TypeError(`Invalid ${name}.`);
  }
}

function validateIdentity(identity: ConnectionIdentity): void {
  validateId(identity.sessionId, "sessionId");
  validateId(identity.connectionId, "connectionId");
  if (
    !Number.isSafeInteger(identity.connectionGeneration) ||
    identity.connectionGeneration < 0
  ) {
    throw new TypeError("Invalid connectionGeneration.");
  }
}

function sameIdentity(
  connection: ActiveConnection,
  identity: ConnectionIdentity
): boolean {
  return (
    connection.sessionId === identity.sessionId &&
    connection.connectionId === identity.connectionId &&
    connection.connectionGeneration === identity.connectionGeneration
  );
}

export class ConnectionHub {
  readonly #connections = new Map<string, ActiveConnection>();
  readonly #sessionsByRoom = new Map<string, Set<string>>();
  readonly #maxBufferedBytes: number;
  readonly #onBackpressure: (
    context: BackpressureContext
  ) => BackpressureAction;

  constructor(options: ConnectionHubOptions = {}) {
    this.#maxBufferedBytes =
      options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.#onBackpressure =
      options.onBackpressure ?? (() => "disconnect");
    if (
      !Number.isSafeInteger(this.#maxBufferedBytes) ||
      this.#maxBufferedBytes <= 0
    ) {
      throw new TypeError("Invalid maxBufferedBytes.");
    }
  }

  get size(): number {
    return this.#connections.size;
  }

  roomSize(roomId: string): number {
    return this.#sessionsByRoom.get(roomId)?.size ?? 0;
  }

  bind(input: BindConnectionInput): BindConnectionResult {
    validateIdentity(input);
    if (input.roomId !== null) validateId(input.roomId, "roomId");
    const previous = this.#connections.get(input.sessionId);
    if (previous === undefined) {
      this.#install(input);
      return { status: "bound" };
    }
    if (input.connectionGeneration < previous.connectionGeneration) {
      return { status: "stale" };
    }
    if (input.connectionGeneration === previous.connectionGeneration) {
      if (
        previous.connectionId === input.connectionId &&
        previous.transport === input.transport &&
        previous.roomId === input.roomId
      ) {
        return { status: "already_bound" };
      }
      return { status: "stale" };
    }

    this.#removeFromRoom(previous);
    this.#install(input);
    this.#safeClose(previous.transport, CLOSE_SUPERSEDED, "superseded");
    return {
      status: "replaced",
      replacedConnectionId: previous.connectionId
    };
  }

  isCurrent(identity: ConnectionIdentity): boolean {
    const current = this.#connections.get(identity.sessionId);
    return current !== undefined && sameIdentity(current, identity);
  }

  setRoom(
    identity: ConnectionIdentity,
    roomId: string | null
  ): GuardedMutationResult {
    validateIdentity(identity);
    if (roomId !== null) validateId(roomId, "roomId");
    const current = this.#connections.get(identity.sessionId);
    if (current === undefined) return { status: "not_found" };
    if (!sameIdentity(current, identity)) return { status: "stale" };
    if (current.roomId === roomId) return { status: "no_change" };

    this.#removeFromRoom(current);
    const replacement: ActiveConnection = { ...current, roomId };
    this.#connections.set(identity.sessionId, replacement);
    this.#addToRoom(replacement);
    return { status: "updated" };
  }

  unbind(identity: ConnectionIdentity): GuardedMutationResult {
    validateIdentity(identity);
    const current = this.#connections.get(identity.sessionId);
    if (current === undefined) return { status: "not_found" };
    if (!sameIdentity(current, identity)) return { status: "stale" };
    this.#detach(current);
    return { status: "updated" };
  }

  send(
    identity: ConnectionIdentity,
    payload: string
  ): ConnectionSendResult {
    validateIdentity(identity);
    const current = this.#connections.get(identity.sessionId);
    if (current === undefined) return { status: "not_found" };
    if (!sameIdentity(current, identity)) return { status: "stale" };
    return this.#sendCurrent(current, payload);
  }

  broadcastRoom(roomId: string, payload: string): RoomBroadcastResult {
    validateId(roomId, "roomId");
    const sessionIds = [...(this.#sessionsByRoom.get(roomId) ?? [])];
    const entries: RoomBroadcastEntry[] = [];
    let accepted = 0;
    for (const sessionId of sessionIds) {
      const connection = this.#connections.get(sessionId);
      const result =
        connection === undefined || connection.roomId !== roomId
          ? { status: "not_found" as const }
          : this.#sendCurrent(connection, payload);
      if (result.status === "accepted") accepted += 1;
      entries.push(Object.freeze({ sessionId, result }));
    }
    return Object.freeze({
      roomId,
      attempted: entries.length,
      accepted,
      entries: Object.freeze(entries)
    });
  }

  #sendCurrent(
    connection: ActiveConnection,
    payload: string
  ): ConnectionSendResult {
    if (this.#connections.get(connection.sessionId) !== connection) {
      return { status: "stale" };
    }
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    const reportedBufferedBytes = connection.transport.bufferedAmount;
    const bufferedBytes =
      Number.isFinite(reportedBufferedBytes) && reportedBufferedBytes >= 0
        ? reportedBufferedBytes
        : Number.POSITIVE_INFINITY;
    if (
      bufferedBytes > this.#maxBufferedBytes - payloadBytes
    ) {
      const context: BackpressureContext = {
        sessionId: connection.sessionId,
        connectionId: connection.connectionId,
        connectionGeneration: connection.connectionGeneration,
        roomId: connection.roomId,
        bufferedBytes,
        payloadBytes,
        maxBufferedBytes: this.#maxBufferedBytes
      };
      let action: BackpressureAction = "disconnect";
      try {
        action = this.#onBackpressure(context);
      } catch {
        action = "disconnect";
      }
      if (this.#connections.get(connection.sessionId) !== connection) {
        return { status: "stale" };
      }
      if (action === "reject") {
        return {
          status: "backpressure_rejected",
          payloadBytes,
          bufferedBytes
        };
      }
      this.#detach(connection);
      this.#safeClose(
        connection.transport,
        CLOSE_BACKPRESSURE,
        "backpressure"
      );
      return {
        status: "backpressure_disconnected",
        payloadBytes,
        bufferedBytes
      };
    }

    try {
      connection.transport.send(payload);
      return { status: "accepted", payloadBytes };
    } catch {
      if (this.#connections.get(connection.sessionId) === connection) {
        this.#detach(connection);
      }
      this.#safeClose(connection.transport, CLOSE_SEND_FAILED, "send failed");
      return { status: "send_failed", payloadBytes };
    }
  }

  #install(connection: ActiveConnection): void {
    this.#connections.set(connection.sessionId, connection);
    this.#addToRoom(connection);
  }

  #detach(connection: ActiveConnection): void {
    if (this.#connections.get(connection.sessionId) !== connection) return;
    this.#connections.delete(connection.sessionId);
    this.#removeFromRoom(connection);
  }

  #addToRoom(connection: ActiveConnection): void {
    if (connection.roomId === null) return;
    let sessions = this.#sessionsByRoom.get(connection.roomId);
    if (sessions === undefined) {
      sessions = new Set<string>();
      this.#sessionsByRoom.set(connection.roomId, sessions);
    }
    sessions.add(connection.sessionId);
  }

  #removeFromRoom(connection: ActiveConnection): void {
    if (connection.roomId === null) return;
    const sessions = this.#sessionsByRoom.get(connection.roomId);
    if (sessions === undefined) return;
    sessions.delete(connection.sessionId);
    if (sessions.size === 0) {
      this.#sessionsByRoom.delete(connection.roomId);
    }
  }

  #safeClose(
    transport: ConnectionTransport,
    code: number,
    reason: string
  ): void {
    try {
      transport.close(code, reason);
    } catch {
      // The registry has already detached the connection.
    }
  }
}
