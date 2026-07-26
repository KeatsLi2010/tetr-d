import {
  DGLAB_ABSOLUTE_MAX_STRENGTH,
  DEFAULT_DGLAB_CONFIG,
  normalizeDgLabConfig
} from "./dglabConfig.ts";
import { DgLabBluetoothTransport } from "./dglabBluetooth.ts";
import { cancellationPoints, createPenaltyCommand } from "./dglabPolicy.ts";
import { waveformPayload } from "./dglabWaveforms.ts";
import type {
  DgLabChannel,
  DgLabChannelState,
  DgLabConfig,
  DgLabPenaltyEvent,
  DgLabStatus,
  DgLabTransport,
  DgLabTransportMessage
} from "./dglabTypes.ts";

export interface DgLabControllerOptions {
  readonly now?: () => number;
  readonly createTransport?: (
    onStatus: (status: DgLabStatus["connection"], clientId: string | null, error?: string) => void,
    config: DgLabConfig
  ) => DgLabTransport;
}

interface QueuedCommand {
  readonly strength: number;
  readonly durationMs: number;
  readonly points: number;
}

type Listener = (status: DgLabStatus) => void;

const INITIAL_CHANNELS: Readonly<Record<DgLabChannel, DgLabChannelState>> = Object.freeze({
  A: Object.freeze({ strength: 0, limit: 0 }),
  B: Object.freeze({ strength: 0, limit: 0 })
});

function channelNumber(channel: DgLabChannel): 1 | 2 {
  return channel === "A" ? 1 : 2;
}

export class DgLabController {
  readonly #now: () => number;
  readonly #createTransport: NonNullable<DgLabControllerOptions["createTransport"]>;
  readonly #listeners = new Set<Listener>();
  #config: DgLabConfig;
  #transport: DgLabTransport | null = null;
  #unsubscribeTransport: (() => void) | null = null;
  #connection: DgLabStatus["connection"] = "offline";
  #channels = INITIAL_CHANNELS;
  #armed = false;
  #lastError: string | null = null;
  #queue: QueuedCommand[] = [];
  #activeTimer: ReturnType<typeof setTimeout> | null = null;
  #lastEventAt = -Infinity;

  constructor(config: DgLabConfig = DEFAULT_DGLAB_CONFIG, options: DgLabControllerOptions = {}) {
    this.#config = normalizeDgLabConfig(config) ?? DEFAULT_DGLAB_CONFIG;
    this.#now = options.now ?? (() => globalThis.performance.now());
    this.#createTransport = options.createTransport ?? ((onStatus, currentConfig) => new DgLabBluetoothTransport({ maxStrength: currentConfig.maxStrength }, onStatus));
  }

  get status(): DgLabStatus {
    return Object.freeze({
      connection: this.#connection,
      armed: this.#armed,
      channels: this.#channels,
      queuedSeconds: this.#queue.reduce((sum, item) => sum + item.durationMs, 0) / 1_000,
      lastError: this.#lastError
    });
  }

  updateConfig(config: DgLabConfig): void {
    const normalized = normalizeDgLabConfig(config);
    if (normalized === null) throw new TypeError("Invalid DG-LAB config.");
    this.#config = normalized;
    this.#transport?.setSafetyLimit?.(normalized.maxStrength);
    if (!normalized.enabled) this.disarm();
    this.#publish();
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.status);
    return () => this.#listeners.delete(listener);
  }

  connect(): void {
    this.#clearError();
    this.#disposeTransport();
    this.#connection = "connecting";
    const transport = this.#createTransport((status, _clientId, error) => {
      this.#connection = status;
      if (status === "paired") this.#clearError();
      if (status === "error") this.#lastError = error === undefined || error.length === 0
        ? "蓝牙连接失败，请确认使用 HTTPS/Chrome 并选择郊狼 3.0。"
        : `蓝牙错误：${error}`;
      if (status !== "paired") this.#armed = false;
      if (status === "offline" || status === "error") this.#stopOutput(true);
      this.#publish();
    }, this.#config);
    this.#transport = transport;
    this.#unsubscribeTransport = transport.subscribe((message) => this.#receive(message));
    transport.connect();
    this.#publish();
  }

  disconnect(): void {
    this.disarm();
    this.#disposeTransport();
    this.#connection = "offline";
    this.#publish();
  }

  arm(): boolean {
    if (!this.#config.enabled || this.#connection !== "paired") {
      this.#fail("请先启用 DG-LAB 并选择蓝牙设备。");
      return false;
    }
    if (this.#config.maxStrength > DGLAB_ABSOLUTE_MAX_STRENGTH) {
      this.#fail("强度超过应用安全上限。");
      return false;
    }
    this.#armed = true;
    this.#clearError();
    this.#publish();
    return true;
  }

  disarm(): void {
    this.#armed = false;
    this.#stopOutput(true);
    this.#publish();
  }

  test(): boolean {
    if (!this.#armed || this.#transport === null) return false;
    const strength = Math.min(this.#config.maxStrength, Math.max(1, this.#config.baseStrength));
    try {
      this.#sendStrength(strength);
      this.#sendWaveform(Math.min(750, this.#config.baseDurationMs));
      return true;
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : "DG-LAB 测试输出失败。");
      return false;
    }
  }

  handleEvent(event: DgLabPenaltyEvent): void {
    if (!this.#armed || this.#transport === null) return;
    const now = this.#now();
    if (now - this.#lastEventAt < this.#config.cooldownMs && event.kind !== "attackCancelled") return;
    this.#lastEventAt = now;
    const cancellation = cancellationPoints(event, this.#config);
    if (cancellation > 0) {
      this.#cancelQueued(cancellation);
      return;
    }
    const command = createPenaltyCommand(event, this.#config);
    if (command === null) return;
    const maxMs = this.#config.maxQueueSeconds * 1_000;
    const queuedMs = this.#queue.reduce((sum, item) => sum + item.durationMs, 0);
    if (queuedMs >= maxMs) return;
    this.#queue.push({
      points: command.points,
      strength: Math.min(command.strength, this.#config.maxStrength),
      durationMs: Math.min(command.durationMs, maxMs - queuedMs)
    });
    this.#publish();
    if (this.#activeTimer === null) this.#pump();
  }

  dispose(): void {
    this.disconnect();
    this.#listeners.clear();
  }

  #pump(): void {
    const next = this.#queue.shift();
    if (next === undefined || !this.#armed || this.#transport === null) {
      this.#publish();
      return;
    }
    try {
      this.#sendStrength(next.strength);
      this.#sendWaveform(next.durationMs);
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : "DG-LAB 输出失败。");
      return;
    }
    this.#activeTimer = setTimeout(() => {
      this.#activeTimer = null;
      if (this.#queue.length > 0) this.#pump();
      else this.#sendStrength(0);
      this.#publish();
    }, next.durationMs);
    this.#publish();
  }

  #cancelQueued(points: number): void {
    let remaining = points;
    while (remaining > 0 && this.#queue.length > 0) {
      const item = this.#queue[this.#queue.length - 1]!;
      if (item.points <= remaining) {
        remaining -= item.points;
        this.#queue.pop();
      } else {
        this.#queue[this.#queue.length - 1] = Object.freeze({
          ...item,
          points: item.points - remaining,
          durationMs: Math.max(100, Math.floor(item.durationMs * (item.points - remaining) / item.points))
        });
        remaining = 0;
      }
    }
    try {
      this.#sendClear();
      if (this.#queue.length > 0 && this.#activeTimer === null) this.#pump();
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : "DG-LAB 取消输出失败。");
    }
    this.#publish();
  }

  #sendStrength(strength: number): void {
    this.#transport?.send({ type: 3, channel: channelNumber(this.#config.channel), strength, message: "set channel" });
  }

  #sendWaveform(durationMs: number): void {
    const time = Math.max(1, Math.ceil(durationMs / 1_000));
    const channel = this.#config.channel;
    this.#transport?.send({
      type: "clientMsg",
      channel,
      time,
      durationMs,
      message: `${channel}:${JSON.stringify(waveformPayload(this.#config.waveform, this.#config.customWaveform))}`
    });
  }

  #sendClear(): void {
    const channel = channelNumber(this.#config.channel);
    this.#transport?.send({ type: 4, message: `clear-${channel}` });
    this.#sendStrength(0);
  }

  #stopOutput(clearDevice: boolean): void {
    if (this.#activeTimer !== null) clearTimeout(this.#activeTimer);
    this.#activeTimer = null;
    this.#queue = [];
    if (clearDevice && this.#transport !== null) {
      try { this.#sendClear(); } catch { /* disconnect/stop is best effort */ }
    }
  }

  #receive(message: DgLabTransportMessage): void {
    if (message.type !== "msg" || typeof message.message !== "string") return;
    const match = /^strength-(\d+)\+(\d+)\+(\d+)\+(\d+)$/.exec(message.message);
    if (match === null) return;
    const aStrength = Number(match[1]);
    const bStrength = Number(match[2]);
    const aLimit = Number(match[3]);
    const bLimit = Number(match[4]);
    if (![aStrength, bStrength, aLimit, bLimit].every(Number.isFinite)) return;
    this.#channels = Object.freeze({
      A: Object.freeze({ strength: aStrength, limit: aLimit }),
      B: Object.freeze({ strength: bStrength, limit: bLimit })
    });
    this.#publish();
  }

  #disposeTransport(): void {
    this.#unsubscribeTransport?.();
    this.#unsubscribeTransport = null;
    this.#transport?.close();
    this.#transport = null;
  }

  #clearError(): void { this.#lastError = null; }

  #fail(message: string): void {
    this.#lastError = message;
    this.#connection = "error";
    this.#armed = false;
    this.#stopOutput(false);
    this.#publish();
  }

  #publish(): void {
    const snapshot = this.status;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
