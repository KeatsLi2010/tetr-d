import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import { PROTOCOL_VERSION } from "../../../../packages/protocol/src/messages.ts";
import { GatewayConnection } from "./gatewayConnection.ts";
import {
  DEFAULT_MAX_PENDING_MESSAGES
} from "./gatewayMessageQueue.ts";
import { ConnectionRateLimiter } from "./rateLimiter.ts";
import type { RealtimeService } from "./realtimeService.ts";
import {
  normalizeHost,
  normalizeHosts,
  normalizeOrigin,
  normalizeOrigins,
  normalizeRemoteAddress
} from "./webSocketPolicy.ts";

export const WEBSOCKET_PATH = "/ws";
export const WEBSOCKET_SUBPROTOCOL = `tetr-d.v${PROTOCOL_VERSION}`;

const CONNECTION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const DEFAULT_MAX_CONNECTIONS = 1_024;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 64;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

export interface WebSocketGatewayOptions {
  readonly server: HttpServer;
  readonly service: RealtimeService;
  readonly allowedOrigins?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly allowUnsafeDevelopmentAccess?: boolean;
  readonly heartbeatMs?: number;
  readonly helloTimeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly maxInvalidMessages?: number;
  readonly maxPendingMessages?: number;
  readonly maxConnections?: number;
  readonly maxConnectionsPerIp?: number;
  readonly shutdownGraceMs?: number;
  readonly connectionIdFactory?: () => string;
  readonly rateLimiter?: ConnectionRateLimiter;
  readonly onError?: (error: unknown) => void;
}

function hasSubprotocol(request: IncomingMessage): boolean {
  const header = request.headers["sec-websocket-protocol"];
  if (typeof header !== "string") return false;
  return header
    .split(",")
    .map((value) => value.trim())
    .includes(WEBSOCKET_SUBPROTOCOL);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  try {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        "Connection: close\r\n" +
        "Content-Length: 0\r\n\r\n"
    );
  } catch {
    socket.destroy();
  }
}

export class WebSocketGateway {
  readonly #server: HttpServer;
  readonly #service: RealtimeService;
  readonly #wss: WebSocketServer;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #allowUnsafeDevelopmentAccess: boolean;
  readonly #heartbeatMs: number;
  readonly #helloTimeoutMs: number;
  readonly #maxInvalidMessages: number;
  readonly #maxPendingMessages: number;
  readonly #maxConnections: number;
  readonly #maxConnectionsPerIp: number;
  readonly #shutdownGraceMs: number;
  readonly #connectionIdFactory: () => string;
  readonly #rateLimiter: ConnectionRateLimiter;
  readonly #onError: (error: unknown) => void;
  readonly #connections = new Set<GatewayConnection>();
  readonly #addressCounts = new Map<string, number>();
  readonly #upgradeHandler: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) => void;
  #pendingUpgrades = 0;
  #disposed = false;
  #closing: Promise<void> | null = null;

  constructor(options: WebSocketGatewayOptions) {
    this.#server = options.server;
    this.#service = options.service;
    this.#allowedOrigins = normalizeOrigins(options.allowedOrigins ?? []);
    this.#allowedHosts = normalizeHosts(options.allowedHosts ?? []);
    this.#allowUnsafeDevelopmentAccess =
      options.allowUnsafeDevelopmentAccess === true;
    if (
      !this.#allowUnsafeDevelopmentAccess &&
      (this.#allowedOrigins.size === 0 || this.#allowedHosts.size === 0)
    ) {
      throw new TypeError("WebSocket Origin and Host allowlists are required.");
    }
    this.#heartbeatMs = options.heartbeatMs ?? 15_000;
    this.#helloTimeoutMs = options.helloTimeoutMs ?? 5_000;
    this.#maxInvalidMessages = options.maxInvalidMessages ?? 3;
    this.#maxPendingMessages =
      options.maxPendingMessages ?? DEFAULT_MAX_PENDING_MESSAGES;
    this.#maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.#maxConnectionsPerIp =
      options.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
    this.#shutdownGraceMs =
      options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.#connectionIdFactory =
      options.connectionIdFactory ?? (() => `c_${randomUUID()}`);
    this.#rateLimiter = options.rateLimiter ?? new ConnectionRateLimiter();
    this.#onError = options.onError ?? (() => undefined);
    const maxPayload = options.maxPayloadBytes ?? 8 * 1024;
    for (const [name, value] of [
      ["heartbeat", this.#heartbeatMs],
      ["hello timeout", this.#helloTimeoutMs],
      ["payload", maxPayload],
      ["invalid message limit", this.#maxInvalidMessages],
      ["message queue capacity", this.#maxPendingMessages],
      ["connection limit", this.#maxConnections],
      ["per-IP connection limit", this.#maxConnectionsPerIp],
      ["shutdown grace", this.#shutdownGraceMs]
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`Invalid ${name}.`);
      }
    }
    if (this.#maxConnectionsPerIp > this.#maxConnections) {
      throw new TypeError("Per-IP connection limit exceeds total limit.");
    }

    this.#wss = new WebSocketServer({
      noServer: true,
      clientTracking: true,
      maxPayload,
      perMessageDeflate: false,
      skipUTF8Validation: false,
      handleProtocols(protocols) {
        return protocols.has(WEBSOCKET_SUBPROTOCOL)
          ? WEBSOCKET_SUBPROTOCOL
          : false;
      }
    });
    this.#upgradeHandler = (request, socket, head) => {
      this.#handleUpgrade(request, socket, head);
    };
    this.#server.on("upgrade", this.#upgradeHandler);
    this.#wss.on("error", (error) => this.#report(error));
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  dispose(): void {
    void this.close().catch((error) => this.#report(error));
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#disposed = true;
    this.#server.off("upgrade", this.#upgradeHandler);
    for (const connection of [...this.#connections]) connection.dispose();
    this.#closing = new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = setTimeout(() => {
        timer = null;
        for (const client of this.#wss.clients) {
          try {
            client.terminate();
          } catch (error) {
            this.#report(error);
          }
        }
      }, this.#shutdownGraceMs);
      const finish = (error?: Error): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (error === undefined) resolve();
        else {
          this.#report(error);
          reject(error);
        }
      };
      try {
        this.#wss.close(finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return this.#closing;
  }

  #handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void {
    if (this.#disposed) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url ?? "", "http://gateway.invalid");
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (target.pathname !== WEBSOCKET_PATH || target.search !== "") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!this.#hostAllowed(request.headers.host)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (!this.#originAllowed(request.headers.origin)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (!hasSubprotocol(request)) {
      rejectUpgrade(socket, 426, "Upgrade Required");
      return;
    }
    const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress);
    if (remoteAddress === null) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    const admissionStatus = this.#reserve(remoteAddress);
    if (admissionStatus !== null) {
      rejectUpgrade(
        socket,
        admissionStatus,
        admissionStatus === 429 ? "Too Many Requests" : "Service Unavailable"
      );
      return;
    }

    let reserved = true;
    const releaseReservation = (): void => {
      if (!reserved) return;
      reserved = false;
      this.#pendingUpgrades -= 1;
      this.#releaseAddress(remoteAddress);
    };
    socket.once("close", releaseReservation);
    try {
      this.#wss.handleUpgrade(request, socket, head, (webSocket) => {
        socket.off("close", releaseReservation);
        if (!reserved || this.#disposed) {
          releaseReservation();
          webSocket.terminate();
          return;
        }
        reserved = false;
        this.#pendingUpgrades -= 1;
        this.#attach(webSocket, remoteAddress);
      });
    } catch (error) {
      releaseReservation();
      this.#report(error);
      socket.destroy();
    }
  }

  #attach(socket: WebSocket, remoteAddress: string): void {
    let connectionId: string;
    try {
      connectionId = this.#connectionIdFactory();
    } catch (error) {
      this.#releaseAddress(remoteAddress);
      socket.terminate();
      this.#report(error);
      return;
    }
    if (!CONNECTION_ID.test(connectionId)) {
      this.#releaseAddress(remoteAddress);
      socket.close(1011, "invalid connection id");
      this.#report(new TypeError("Connection ID factory returned an invalid ID."));
      return;
    }
    let connection: GatewayConnection;
    try {
      connection = new GatewayConnection({
        socket,
        connectionId,
        service: this.#service,
        rateLimiter: this.#rateLimiter,
        heartbeatMs: this.#heartbeatMs,
        helloTimeoutMs: this.#helloTimeoutMs,
        maxInvalidMessages: this.#maxInvalidMessages,
        maxPendingMessages: this.#maxPendingMessages,
        onClose: () => {
          if (this.#connections.delete(connection)) {
            this.#releaseAddress(remoteAddress);
          }
        },
        onError: this.#onError
      });
    } catch (error) {
      this.#releaseAddress(remoteAddress);
      socket.terminate();
      this.#report(error);
      return;
    }
    this.#connections.add(connection);
  }

  #reserve(remoteAddress: string): 429 | 503 | null {
    if (this.#connections.size + this.#pendingUpgrades >= this.#maxConnections) {
      return 503;
    }
    const addressCount = this.#addressCounts.get(remoteAddress) ?? 0;
    if (addressCount >= this.#maxConnectionsPerIp) return 429;
    this.#pendingUpgrades += 1;
    this.#addressCounts.set(remoteAddress, addressCount + 1);
    return null;
  }

  #releaseAddress(remoteAddress: string): void {
    const count = this.#addressCounts.get(remoteAddress);
    if (count === undefined || count <= 1) {
      this.#addressCounts.delete(remoteAddress);
      return;
    }
    this.#addressCounts.set(remoteAddress, count - 1);
  }

  #hostAllowed(host: string | undefined): boolean {
    if (this.#allowedHosts.size === 0) return this.#allowUnsafeDevelopmentAccess;
    if (host === undefined) return false;
    const normalized = normalizeHost(host);
    return normalized !== null && this.#allowedHosts.has(normalized);
  }

  #originAllowed(origin: string | undefined): boolean {
    if (this.#allowedOrigins.size === 0) {
      return this.#allowUnsafeDevelopmentAccess;
    }
    if (origin === undefined) return false;
    const normalized = normalizeOrigin(origin);
    return normalized !== null && this.#allowedOrigins.has(normalized);
  }

  #report(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Logging is a terminal boundary.
    }
  }
}
