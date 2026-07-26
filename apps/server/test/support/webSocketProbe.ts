import WebSocket from "ws";

import type {
  ClientMessage,
  ServerMessage
} from "../../../../packages/protocol/src/messages.ts";

const DEFAULT_TIMEOUT_MS = 5_000;

export type MessageOf<Type extends ServerMessage["type"]> =
  Extract<ServerMessage, { readonly type: Type }>;

interface MessageWaiter {
  readonly accepts: (message: ServerMessage) => boolean;
  readonly resolve: (message: ServerMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface CloseInfo {
  readonly code: number;
  readonly reason: string;
}

export interface OpenWebSocketProbeOptions {
  readonly origin: string;
  readonly host: string;
  readonly subprotocol: string;
  readonly timeoutMs?: number;
}

export class WebSocketProbe {
  readonly socket: WebSocket;
  readonly #messages: ServerMessage[] = [];
  readonly #waiters: MessageWaiter[] = [];
  readonly #closeWaiters: {
    readonly resolve: (info: CloseInfo) => void;
    readonly timer: NodeJS.Timeout;
  }[] = [];
  #closed: CloseInfo | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => this.#receive(data.toString()));
    socket.once("close", (code, reason) => {
      this.#closed = { code, reason: reason.toString() };
      this.#rejectMessageWaiters(
        new Error(`Socket closed before message (${code}).`)
      );
      for (const waiter of this.#closeWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(this.#closed);
      }
    });
    socket.on("error", (error) => this.#rejectMessageWaiters(error));
  }

  static async open(
    url: string,
    options: OpenWebSocketProbeOptions
  ): Promise<WebSocketProbe> {
    const socket = new WebSocket(url, options.subprotocol, {
      origin: options.origin,
      headers: { host: options.host }
    });
    const probe = new WebSocketProbe(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out opening WebSocket."));
        socket.terminate();
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return probe;
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  waitFor<Type extends ServerMessage["type"]>(
    type: Type,
    predicate: (message: MessageOf<Type>) => boolean = () => true,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<MessageOf<Type>> {
    const index = this.#messages.findIndex(
      (message) => message.type === type &&
        predicate(message as MessageOf<Type>)
    );
    if (index >= 0) {
      return Promise.resolve(
        this.#messages.splice(index, 1)[0] as MessageOf<Type>
      );
    }
    if (this.#closed !== null) {
      return Promise.reject(
        new Error(`Socket already closed (${this.#closed.code}).`)
      );
    }
    return new Promise<MessageOf<Type>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.#waiters.indexOf(waiter);
        if (waiterIndex >= 0) this.#waiters.splice(waiterIndex, 1);
        reject(new Error(`Timed out waiting for ${type}.`));
      }, timeoutMs);
      const waiter: MessageWaiter = {
        accepts: (message) => message.type === type &&
          predicate(message as MessageOf<Type>),
        resolve: (message) => resolve(message as MessageOf<Type>),
        reject,
        timer
      };
      this.#waiters.push(waiter);
    });
  }

  waitForClose(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CloseInfo> {
    if (this.#closed !== null) return Promise.resolve(this.#closed);
    return new Promise<CloseInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#closeWaiters.findIndex(
          (waiter) => waiter.resolve === resolve
        );
        if (index >= 0) this.#closeWaiters.splice(index, 1);
        reject(new Error("Timed out waiting for WebSocket close."));
      }, timeoutMs);
      this.#closeWaiters.push({ resolve, timer });
    });
  }

  terminate(): void {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.terminate();
  }

  #receive(payload: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(payload) as ServerMessage;
    } catch {
      this.#rejectMessageWaiters(new Error("Server sent invalid JSON."));
      return;
    }
    const index = this.#waiters.findIndex((waiter) => waiter.accepts(message));
    if (index < 0) {
      this.#messages.push(message);
      return;
    }
    const [waiter] = this.#waiters.splice(index, 1);
    clearTimeout(waiter!.timer);
    waiter!.resolve(message);
  }

  #rejectMessageWaiters(error: Error): void {
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}
