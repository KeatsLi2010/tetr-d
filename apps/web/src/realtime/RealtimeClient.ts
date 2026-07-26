import type {
  ClientMessage,
  ServerMessage
} from "@tetr-d/protocol";

export interface RealtimeConnectionOptions {
  readonly displayName: string;
  readonly resumeToken?: string;
  readonly onMessage: (message: ServerMessage) => void;
  readonly onClose: (event: CloseEvent) => void;
}

export type AuthOkMessage = Extract<
  ServerMessage,
  { readonly type: "auth.ok" }
>;

export class RealtimeConnectError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "RealtimeConnectError";
    this.code = code;
  }
}

const CONNECT_TIMEOUT_MS = 8_000;

function websocketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
}

function serverMessage(value: unknown): ServerMessage | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof value.type !== "string"
  ) return null;
  return value as ServerMessage;
}

export class RealtimeClient {
  readonly #socket: WebSocket;
  readonly #onMessage: RealtimeConnectionOptions["onMessage"];
  readonly #onClose: RealtimeConnectionOptions["onClose"];
  #closed = false;

  private constructor(
    socket: WebSocket,
    options: RealtimeConnectionOptions
  ) {
    this.#socket = socket;
    this.#onMessage = options.onMessage;
    this.#onClose = options.onClose;
    socket.addEventListener("message", (event) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(String(event.data));
      } catch {
        this.close(1002, "invalid JSON");
        return;
      }
      const message = serverMessage(decoded);
      if (message === null) {
        this.close(1002, "invalid message");
        return;
      }
      this.#onMessage(message);
    });
    socket.addEventListener("close", (event) => {
      this.#closed = true;
      this.#onClose(event);
    });
  }

  static connect(
    options: RealtimeConnectionOptions
  ): Promise<{ readonly client: RealtimeClient; readonly auth: AuthOkMessage }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(websocketUrl(), "tetr-d.v3");
      const client = new RealtimeClient(socket, options);
      let welcomed = false;
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        client.close(1000, "connect timeout");
        reject(new RealtimeConnectError("连接服务器超时。"));
      }, CONNECT_TIMEOUT_MS);

      const finish = (
        callback: () => void
      ): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        socket.removeEventListener("message", handshake);
        callback();
      };
      const handshake = (event: MessageEvent) => {
        let message: ServerMessage | null = null;
        try {
          message = serverMessage(JSON.parse(String(event.data)));
        } catch {
          finish(() => reject(
            new RealtimeConnectError("服务器返回了无效消息。")
          ));
          return;
        }
        if (message?.type === "welcome") {
          welcomed = true;
          if (options.resumeToken === undefined) {
            client.send({
              type: "auth.guest",
              displayName: options.displayName
            });
          }
          return;
        }
        if (message?.type === "auth.ok") {
          finish(() => resolve({ client, auth: message as AuthOkMessage }));
          return;
        }
        if (message?.type === "error") {
          finish(() => {
            client.close(1000, "authentication rejected");
            reject(new RealtimeConnectError(
              message.message,
              message.code
            ));
          });
        }
      };
      socket.addEventListener("message", handshake);
      socket.addEventListener("open", () => {
        const hello: ClientMessage = {
          type: "hello",
          protocolVersion: 3,
          buildId: "tetr-d-web-duel",
          ...(options.resumeToken === undefined
            ? {}
            : { resumeToken: options.resumeToken })
        };
        client.send(hello);
      }, { once: true });
      socket.addEventListener("error", () => {
        finish(() => reject(
          new RealtimeConnectError("无法连接实时对战服务器。")
        ));
      }, { once: true });
      socket.addEventListener("close", () => {
        finish(() => reject(
          new RealtimeConnectError("实时连接在认证前关闭。")
        ));
      }, { once: true });
    });
  }

  get isOpen(): boolean {
    return !this.#closed && this.#socket.readyState === WebSocket.OPEN;
  }

  send(message: ClientMessage): void {
    if (!this.isOpen) throw new Error("实时连接尚未打开。");
    this.#socket.send(JSON.stringify(message));
  }

  close(code = 1000, reason = "client close"): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#socket.readyState < WebSocket.CLOSING) {
      this.#socket.close(code, reason);
    }
  }
}
