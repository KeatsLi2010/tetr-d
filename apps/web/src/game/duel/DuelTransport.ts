import type {
  ClientMessage,
  ServerMessage
} from "@tetr-d/protocol";

import {
  RealtimeClient,
  RealtimeConnectError,
  type AuthOkMessage
} from "../../realtime/RealtimeClient.ts";
import type { DuelConnectionStatus } from "./duelTypes.ts";

const TOKEN_KEY = "tetr-d.duel.resume-token";
const NAME_KEY = "tetr-d.duel.display-name";
const RECONNECT_BUDGET_MS = 15_000;
const RECONNECT_INITIAL_DELAY_MS = 400;
const RECONNECT_MAX_DELAY_MS = 1_000;

export interface DuelTransportOptions {
  readonly onMessage: (message: ServerMessage) => void;
  readonly onAuth: (message: AuthOkMessage) => void;
  readonly onStatus: (status: DuelConnectionStatus) => void;
}

export class DuelTransport {
  readonly #options: DuelTransportOptions;
  #client: RealtimeClient | null = null;
  #resumeToken: string | null = null;
  #displayName = "";
  #generation = 0;
  #reconnectAttempts = 0;
  #disposed = false;
  #deliberateClose = false;
  #reconnectTimer: number | null = null;
  #reconnectStartedAtMs: number | null = null;

  constructor(options: DuelTransportOptions) {
    this.#options = options;
  }

  hasSavedSession(): boolean {
    return sessionStorage.getItem(TOKEN_KEY) !== null &&
      sessionStorage.getItem(NAME_KEY) !== null;
  }

  async resumeSaved(): Promise<boolean> {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const displayName = sessionStorage.getItem(NAME_KEY);
    if (token === null || displayName === null) return false;
    this.#resumeToken = token;
    this.#displayName = displayName;
    try {
      await this.#connect(displayName, token);
      return true;
    } catch (error) {
      if (this.#resumeWasRejected(error)) this.#discardSavedSession();
      else this.#connectionLost();
      return false;
    }
  }

  async connectGuest(displayName: string): Promise<void> {
    if (this.#client?.isOpen) return;
    await this.#connect(displayName);
  }

  send(message: ClientMessage): void {
    if (this.#client === null) throw new Error("实时连接尚未打开。");
    this.#client.send(message);
  }

  close(clearSavedSession: boolean): void {
    this.#deliberateClose = true;
    this.#generation += 1;
    this.#clearReconnectTimer();
    this.#client?.close();
    this.#client = null;
    if (clearSavedSession) {
      this.#resumeToken = null;
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(NAME_KEY);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.close(false);
  }

  async #connect(displayName: string, resumeToken?: string): Promise<void> {
    this.#clearReconnectTimer();
    const generation = ++this.#generation;
    this.#displayName = displayName;
    this.#deliberateClose = false;
    this.#options.onStatus("connecting");
    const { client, auth } = await RealtimeClient.connect({
      displayName,
      ...(resumeToken === undefined ? {} : { resumeToken }),
      onMessage: (message) => {
        if (generation === this.#generation) {
          this.#options.onMessage(message);
        }
      },
      onClose: () => {
        if (generation === this.#generation) this.#connectionLost();
      }
    });
    this.#persistAuth(auth);
    if (generation !== this.#generation || this.#disposed) {
      client.close();
      return;
    }
    this.#client = client;
    this.#options.onAuth(auth);
    this.#options.onStatus("connected");
    this.#reconnectAttempts = 0;
    this.#reconnectStartedAtMs = null;
  }

  #persistAuth(auth: AuthOkMessage): void {
    this.#resumeToken = auth.resumeToken;
    sessionStorage.setItem(TOKEN_KEY, auth.resumeToken);
    sessionStorage.setItem(NAME_KEY, auth.player.displayName);
  }

  #connectionLost(): void {
    if (this.#disposed || this.#deliberateClose) return;
    this.#client = null;
    this.#options.onStatus("disconnected");
    const nowMs = performance.now();
    this.#reconnectStartedAtMs ??= nowMs;
    if (
      this.#resumeToken === null ||
      nowMs - this.#reconnectStartedAtMs >= RECONNECT_BUDGET_MS ||
      this.#reconnectTimer !== null
    ) return;
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_INITIAL_DELAY_MS * 2 ** this.#reconnectAttempts
    );
    this.#reconnectAttempts += 1;
    this.#reconnectTimer = window.setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#disposed || this.#deliberateClose) return;
      void this.#connect(this.#displayName, this.#resumeToken ?? undefined)
        .catch((error) => {
          if (this.#resumeWasRejected(error)) {
            this.#discardSavedSession();
            return;
          }
          this.#connectionLost();
        });
    }, delay);
  }

  #resumeWasRejected(error: unknown): boolean {
    return error instanceof RealtimeConnectError &&
      error.code === "AUTH_REQUIRED";
  }

  #discardSavedSession(): void {
    this.#resumeToken = null;
    this.#clearReconnectTimer();
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(NAME_KEY);
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === null) return;
    window.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }
}
