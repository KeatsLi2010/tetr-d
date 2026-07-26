import type {
  DgLabConnectionStatus,
  DgLabTransport,
  DgLabTransportMessage
} from "./dglabTypes.ts";

type Listener = (message: DgLabTransportMessage) => void;

function asMessage(value: unknown): DgLabTransportMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  return typeof source.type === "string" || typeof source.type === "number"
    ? source as unknown as DgLabTransportMessage
    : null;
}

export function makePairingUrl(wsUrl: string, clientId: string): string {
  const endpoint = wsUrl.replace(/\/$/, "");
  return `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#${endpoint}/${clientId}`;
}

export class DgLabSocketTransport implements DgLabTransport {
  #socket: WebSocket | null = null;
  #clientId: string | null = null;
  #targetId: string | null = null;
  #status: DgLabConnectionStatus = "offline";
  readonly #listeners = new Set<Listener>();
  readonly #url: string;
  #onStatus: (status: DgLabConnectionStatus, clientId: string | null) => void;

  constructor(
    url: string,
    onStatus: (status: DgLabConnectionStatus, clientId: string | null) => void = () => undefined
  ) {
    if (!url.trim()) throw new TypeError("DG-LAB WebSocket URL is required.");
    this.#url = url.trim();
    this.#onStatus = onStatus;
  }

  get status(): DgLabConnectionStatus { return this.#status; }

  connect(): void {
    this.close();
    this.#setStatus("connecting");
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    socket.addEventListener("open", () => this.#setStatus("waiting-bind"));
    socket.addEventListener("message", (event) => {
      let value: unknown;
      try { value = JSON.parse(String(event.data)); } catch { return; }
      const message = asMessage(value);
      if (message === null) return;
      if (message.type === "bind" && message.targetId === "" && message.clientId) {
        this.#clientId = message.clientId;
        this.#emit(message);
      } else if (message.type === "bind" && message.message === "200") {
        this.#targetId = message.targetId ?? null;
        this.#setStatus("paired");
        this.#emit(message);
      } else if (message.type === "break" || message.type === "error") {
        this.#setStatus("error");
        this.#emit(message);
      } else {
        this.#emit(message);
      }
    });
    socket.addEventListener("close", () => {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#setStatus("offline");
      }
    });
    socket.addEventListener("error", () => this.#setStatus("error"));
  }

  close(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#clientId = null;
    this.#targetId = null;
    if (socket !== null) socket.close();
    this.#setStatus("offline");
  }

  send(message: DgLabTransportMessage): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) throw new Error("DG-LAB WebSocket is not paired.");
    this.#socket.send(JSON.stringify({
      ...message,
      clientId: message.clientId ?? this.#clientId ?? "",
      targetId: message.targetId ?? this.#targetId ?? ""
    }));
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(message: DgLabTransportMessage): void {
    for (const listener of this.#listeners) listener(message);
  }

  #setStatus(status: DgLabConnectionStatus): void {
    this.#status = status;
    this.#onStatus(status, this.#clientId);
  }
}
