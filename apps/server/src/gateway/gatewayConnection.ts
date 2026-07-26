import WebSocket from "ws";
import type { RawData } from "ws";

import {
  PROTOCOL_VERSION
} from "../../../../packages/protocol/src/messages.ts";
import type {
  ClientMessage,
  ProtocolErrorCode,
  ServerMessage
} from "../../../../packages/protocol/src/messages.ts";
import { parseClientMessage } from "./schemas/clientMessages.ts";
import type { ConnectionRateLimiter } from "./rateLimiter.ts";
import { GuestCreationRateLimitError } from "./realtimeService.ts";
import type {
  AuthenticatedConnection,
  AuthenticationSuccess,
  RealtimeService
} from "./realtimeService.ts";
import { GatewayMessageQueue } from "./gatewayMessageQueue.ts";

const POLICY_VIOLATION = 1008;
const INTERNAL_ERROR = 1011;
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;

export interface GatewayConnectionOptions {
  readonly socket: WebSocket;
  readonly connectionId: string;
  readonly service: RealtimeService;
  readonly rateLimiter: ConnectionRateLimiter;
  readonly heartbeatMs: number;
  readonly helloTimeoutMs: number;
  readonly authTimeoutMs?: number;
  readonly maxInvalidMessages: number;
  readonly maxPendingMessages?: number;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
}

export class GatewayConnection {
  readonly #socket: WebSocket;
  readonly #connectionId: string;
  readonly #service: RealtimeService;
  readonly #rateLimiter: ConnectionRateLimiter;
  readonly #heartbeatMs: number;
  readonly #authTimeoutMs: number;
  readonly #maxInvalidMessages: number;
  readonly #messages: GatewayMessageQueue;
  readonly #onClose: () => void;
  readonly #onError: (error: unknown) => void;
  readonly #helloTimer: NodeJS.Timeout;
  readonly #heartbeatTimer: NodeJS.Timeout;
  #authTimer: NodeJS.Timeout | null = null;
  #context: AuthenticatedConnection | null = null;
  #helloReceived = false;
  #invalidMessages = 0;
  #alive = true;
  #terminal = false;
  #disposed = false;

  constructor(options: GatewayConnectionOptions) {
    this.#socket = options.socket;
    this.#connectionId = options.connectionId;
    this.#service = options.service;
    this.#rateLimiter = options.rateLimiter;
    this.#heartbeatMs = options.heartbeatMs;
    this.#authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#authTimeoutMs) || this.#authTimeoutMs <= 0) {
      throw new TypeError("Invalid authentication timeout.");
    }
    this.#maxInvalidMessages = options.maxInvalidMessages;
    this.#onClose = options.onClose;
    this.#onError = options.onError ?? (() => undefined);
    this.#messages = new GatewayMessageQueue({
      capacity: options.maxPendingMessages,
      onError: (error) => {
        if (this.#terminal || this.#disposed) return;
        this.#report(error);
        this.#beginClose(INTERNAL_ERROR, "gateway error");
      }
    });

    this.#helloTimer = setTimeout(() => {
      if (this.#terminal || this.#disposed) return;
      this.#sendError("AUTH_REQUIRED", "hello timeout", false);
      this.#beginClose(POLICY_VIOLATION, "hello timeout");
    }, options.helloTimeoutMs);
    this.#helloTimer.unref();
    this.#heartbeatTimer = setInterval(
      () => this.#heartbeat(),
      this.#heartbeatMs
    );
    this.#heartbeatTimer.unref();

    this.#socket.on("message", (data, isBinary) => {
      if (this.#terminal || this.#disposed) return;
      if (!this.#messages.enqueue(() => this.#handleRaw(data, isBinary))) {
        this.#beginClose(POLICY_VIOLATION, "message queue capacity");
      }
    });
    this.#socket.on("pong", () => {
      this.#alive = true;
    });
    this.#socket.once("close", () => this.#dispose(false));
    this.#socket.on("error", (error) => this.#report(error));
  }

  dispose(): void {
    this.#dispose(true);
  }

  get pendingMessageCount(): number {
    return this.#messages.pendingCount;
  }

  async #handleRaw(data: RawData, isBinary: boolean): Promise<void> {
    if (this.#terminal || this.#disposed) return;
    if (isBinary) {
      this.#rateLimiter.consume(this.#connectionId, "general");
      this.#invalid("Binary messages are not supported.");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.#rateLimiter.consume(this.#connectionId, "general");
      this.#invalid("Malformed JSON message.");
      return;
    }
    const message = parseClientMessage(parsed);
    if (message === null) {
      this.#rateLimiter.consume(this.#connectionId, "general");
      this.#invalid("Message failed schema validation.");
      return;
    }
    const tier = message.type === "match.input" ? "match.input" : "general";
    const decision = this.#rateLimiter.consume(this.#connectionId, tier);
    if (!decision.allowed) {
      this.#sendError(
        "RATE_LIMITED",
        decision.reason === "capacity"
          ? "Rate limiter capacity reached."
          : `Rate limited; retry after ${decision.retryAfterMs}ms.`,
        true
      );
      return;
    }
    await this.#handleMessage(message);
  }

  async #handleMessage(message: ClientMessage): Promise<void> {
    if (!this.#helloReceived) {
      if (message.type !== "hello") {
        this.#invalid("hello must be the first message.");
        return;
      }
      await this.#handleHello(message);
      return;
    }

    if (message.type === "hello") {
      this.#invalid("hello may only be sent once.");
      return;
    }
    if (message.type === "ping") {
      this.#send({
        type: "pong",
        clientTime: message.clientTime,
        serverTime: Date.now()
      });
      return;
    }
    if (this.#context === null) {
      if (message.type !== "auth.guest") {
        this.#sendError("AUTH_REQUIRED", "Guest authentication required.", true);
        return;
      }
      await this.#authenticateGuest(message.displayName);
      return;
    }
    if (message.type === "auth.guest") {
      this.#invalid("Connection is already authenticated.");
      return;
    }
    await this.#service.handleMessage(this.#context, message);
  }

  async #handleHello(
    message: Extract<ClientMessage, { readonly type: "hello" }>
  ): Promise<void> {
    this.#helloReceived = true;
    clearTimeout(this.#helloTimer);
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      this.#sendError(
        "PROTOCOL_MISMATCH",
        `Expected protocol ${PROTOCOL_VERSION}.`,
        false
      );
      this.#beginClose(1002, "protocol mismatch");
      return;
    }
    this.#send({
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      connectionId: this.#connectionId,
      heartbeatMs: this.#heartbeatMs
    });
    if (this.#terminal || this.#disposed) return;
    if (message.resumeToken === undefined) {
      this.#startAuthTimer();
      return;
    }
    const authenticated = this.#service.resumeGuest(
      this.#connectionId,
      this.#socket,
      message.resumeToken
    );
    if (authenticated === null) {
      this.#sendError("AUTH_REQUIRED", "Resume token is invalid or expired.", true);
      this.#startAuthTimer();
      return;
    }
    await this.#completeAuthentication(authenticated);
  }

  async #authenticateGuest(displayName: string): Promise<void> {
    try {
      const authenticated = this.#service.createGuest(
        this.#connectionId,
        this.#socket,
        displayName
      );
      await this.#completeAuthentication(authenticated);
    } catch (error) {
      if (error instanceof GuestCreationRateLimitError) {
        this.#sendError(
          "RATE_LIMITED",
          `Guest creation rate limited; retry after ${error.retryAfterMs}ms.`,
          true
        );
        return;
      }
      this.#report(error);
      this.#invalid("Guest authentication failed.");
    }
  }

  async #completeAuthentication(
    authenticated: AuthenticationSuccess
  ): Promise<void> {
    if (this.#terminal || this.#disposed) return;
    this.#clearAuthTimer();
    this.#context = authenticated.context;
    this.#send({
      type: "auth.ok",
      player: authenticated.context.player,
      resumeToken: authenticated.resumeToken
    });
    if (this.#terminal || this.#disposed) return;
    await this.#service.afterAuthenticated(authenticated.context);
  }

  #invalid(message: string): void {
    if (this.#terminal || this.#disposed) return;
    this.#invalidMessages += 1;
    this.#sendError("MESSAGE_INVALID", message, false);
    if (this.#invalidMessages >= this.#maxInvalidMessages) {
      this.#beginClose(POLICY_VIOLATION, "too many invalid messages");
    }
  }

  #sendError(
    code: ProtocolErrorCode,
    message: string,
    retryable: boolean
  ): void {
    this.#send({ type: "error", code, message, retryable });
  }

  #send(message: ServerMessage): void {
    if (this.#terminal || this.#disposed) return;
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    try {
      this.#socket.send(JSON.stringify(message));
    } catch (error) {
      this.#report(error);
      this.#beginClose(INTERNAL_ERROR, "send failed");
    }
  }

  #heartbeat(): void {
    if (
      this.#terminal ||
      this.#disposed ||
      this.#socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    if (!this.#alive) {
      this.#beginTerminate();
      return;
    }
    this.#alive = false;
    try {
      this.#socket.ping();
    } catch (error) {
      this.#report(error);
      this.#beginTerminate();
    }
  }

  #startAuthTimer(): void {
    if (this.#terminal || this.#disposed || this.#context !== null) return;
    this.#clearAuthTimer();
    this.#authTimer = setTimeout(() => {
      if (this.#terminal || this.#disposed || this.#context !== null) return;
      this.#sendError("AUTH_REQUIRED", "authentication timeout", false);
      this.#beginClose(POLICY_VIOLATION, "authentication timeout");
    }, this.#authTimeoutMs);
    this.#authTimer.unref();
  }

  #clearAuthTimer(): void {
    if (this.#authTimer === null) return;
    clearTimeout(this.#authTimer);
    this.#authTimer = null;
  }

  #beginClose(code: number, reason: string): void {
    if (this.#terminal || this.#disposed) return;
    this.#terminal = true;
    clearTimeout(this.#helloTimer);
    this.#clearAuthTimer();
    this.#closeSocket(code, reason);
  }

  #closeSocket(code: number, reason: string): void {
    if (this.#socket.readyState >= WebSocket.CLOSING) return;
    try {
      this.#socket.close(code, reason);
    } catch (error) {
      this.#report(error);
      this.#forceTerminate();
    }
  }

  #beginTerminate(): void {
    if (this.#terminal || this.#disposed) return;
    this.#terminal = true;
    clearTimeout(this.#helloTimer);
    this.#clearAuthTimer();
    this.#forceTerminate();
  }

  #forceTerminate(): void {
    try {
      this.#socket.terminate();
    } catch (error) {
      this.#report(error);
    }
  }

  #dispose(closeSocket: boolean): void {
    if (this.#disposed) return;
    this.#terminal = true;
    this.#disposed = true;
    clearTimeout(this.#helloTimer);
    this.#clearAuthTimer();
    clearInterval(this.#heartbeatTimer);
    this.#rateLimiter.remove(this.#connectionId);
    const context = this.#context;
    this.#context = null;
    if (closeSocket) this.#closeSocket(1001, "server shutdown");
    if (context !== null) {
      void this.#service.disconnect(context).catch((error) => this.#report(error));
    }
    this.#onClose();
  }

  #report(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Logging is a terminal boundary.
    }
  }
}
