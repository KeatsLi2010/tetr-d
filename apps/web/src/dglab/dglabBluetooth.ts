import type { DgLabConnectionStatus, DgLabTransport, DgLabTransportMessage } from "./dglabTypes.ts";

export const DGLAB_BLUETOOTH_SERVICE_UUID = "0000180c-0000-1000-8000-00805f9b34fb";
export const DGLAB_BLUETOOTH_WRITE_UUID = "0000150a-0000-1000-8000-00805f9b34fb";
export const DGLAB_BLUETOOTH_NOTIFY_UUID = "0000150b-0000-1000-8000-00805f9b34fb";
export const DGLAB_BLUETOOTH_BATTERY_UUID = "00001500-0000-1000-8000-00805f9b34fb";

interface CharacteristicEvent {
  readonly target?: { readonly value?: DataView };
}

export interface DgLabBluetoothCharacteristic {
  readonly value?: DataView;
  readonly writeValue?: (value: BufferSource) => Promise<void>;
  readonly writeValueWithResponse?: (value: BufferSource) => Promise<void>;
  readonly startNotifications: () => Promise<DgLabBluetoothCharacteristic>;
  readonly addEventListener: (type: "characteristicvaluechanged", listener: (event: CharacteristicEvent) => void) => void;
  readonly removeEventListener?: (type: "characteristicvaluechanged", listener: (event: CharacteristicEvent) => void) => void;
}

export interface DgLabBluetoothService {
  readonly getCharacteristic: (uuid: string) => Promise<DgLabBluetoothCharacteristic>;
}

export interface DgLabBluetoothServer {
  readonly getPrimaryService: (uuid: string) => Promise<DgLabBluetoothService>;
  readonly disconnect: () => void;
}

export interface DgLabBluetoothDevice {
  readonly id: string;
  readonly name?: string;
  readonly gatt: { readonly connect: () => Promise<DgLabBluetoothServer>; } | null;
  readonly addEventListener: (type: "gattserverdisconnected", listener: () => void) => void;
  readonly removeEventListener?: (type: "gattserverdisconnected", listener: () => void) => void;
}

export interface DgLabBluetoothAdapter {
  readonly requestDevice: (options: {
    readonly filters: readonly [{ readonly namePrefix: string }];
    readonly optionalServices: readonly [string];
  }) => Promise<DgLabBluetoothDevice>;
}

export interface DgLabBluetoothTransportOptions {
  readonly maxStrength: number;
  readonly adapter?: DgLabBluetoothAdapter;
}

type StatusListener = (status: DgLabConnectionStatus, clientId: string | null) => void;
type MessageListener = (message: DgLabTransportMessage) => void;

const INVALID_WAVEFORM = Object.freeze({ frequencies: [10, 10, 10, 10], intensities: [101, 101, 101, 101] });

function browserAdapter(): DgLabBluetoothAdapter | undefined {
  const candidate = (globalThis.navigator as Navigator & { readonly bluetooth?: DgLabBluetoothAdapter } | undefined)?.bluetooth;
  return candidate;
}

export function isWebBluetoothSupported(): boolean {
  return globalThis.isSecureContext === true && browserAdapter() !== undefined;
}

function clampStrength(value: number): number {
  return Math.max(0, Math.min(200, Math.round(Number.isFinite(value) ? value : 0)));
}

function byte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexBytes(value: string): readonly number[] | null {
  if (!/^[0-9A-Fa-f]{16}$/.test(value)) return null;
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 2) bytes.push(Number.parseInt(value.slice(index, index + 2), 16));
  return bytes;
}

function softLimitFrame(limit: number): Uint8Array {
  const value = clampStrength(limit);
  return Uint8Array.from([0xBF, value, value, 0, 0, 0, 0]);
}

export class DgLabBluetoothTransport implements DgLabTransport {
  #status: DgLabConnectionStatus = "offline";
  #device: DgLabBluetoothDevice | null = null;
  #server: DgLabBluetoothServer | null = null;
  #writeCharacteristic: DgLabBluetoothCharacteristic | null = null;
  #notifyCharacteristic: DgLabBluetoothCharacteristic | null = null;
  #waveformTimer: ReturnType<typeof setInterval> | null = null;
  #waveformStopTimer: ReturnType<typeof setTimeout> | null = null;
  #writeQueue: Promise<void> = Promise.resolve();
  #strengthA = 0;
  #strengthB = 0;
  #waveformChannel: "A" | "B" = "A";
  #waveformPayload: readonly string[] = [];
  #waveformIndex = 0;
  #generation = 0;
  #maxStrength: number;
  readonly #adapter: DgLabBluetoothAdapter | undefined;
  readonly #onStatus: StatusListener;
  readonly #listeners = new Set<MessageListener>();
  readonly #onDisconnected = (): void => this.#handleDisconnected();
  readonly #onNotification = (event: CharacteristicEvent): void => this.#receive(event.target?.value);

  constructor(options: DgLabBluetoothTransportOptions, onStatus: StatusListener = () => undefined) {
    this.#maxStrength = clampStrength(options.maxStrength);
    this.#adapter = options.adapter ?? browserAdapter();
    this.#onStatus = onStatus;
  }

  get status(): DgLabConnectionStatus { return this.#status; }

  connect(): void {
    this.close();
    this.#setStatus("connecting");
    const generation = ++this.#generation;
    void this.#connect(generation).catch(() => {
      if (generation !== this.#generation) return;
      this.#setStatus("error");
    });
  }

  close(): void {
    this.#generation += 1;
    this.#stopWaveform();
    this.#notifyCharacteristic?.removeEventListener?.("characteristicvaluechanged", this.#onNotification);
    this.#device?.removeEventListener?.("gattserverdisconnected", this.#onDisconnected);
    this.#server?.disconnect();
    this.#device = null;
    this.#server = null;
    this.#writeCharacteristic = null;
    this.#notifyCharacteristic = null;
    this.#strengthA = 0;
    this.#strengthB = 0;
    this.#setStatus("offline");
  }

  send(message: DgLabTransportMessage): void {
    if (this.#writeCharacteristic === null || this.#status !== "paired") throw new Error("DG-LAB 蓝牙尚未连接。");
    if (message.type === 3) {
      const strength = clampStrength(message.strength ?? 0);
      if (message.channel === 1) this.#strengthA = strength;
      if (message.channel === 2) this.#strengthB = strength;
      this.#queueFrame();
      return;
    }
    if (message.type === 4 && typeof message.message === "string" && message.message.startsWith("clear-")) {
      this.#stopWaveform();
      this.#strengthA = 0;
      this.#strengthB = 0;
      this.#queueFrame();
      return;
    }
    if (message.type !== "clientMsg" || typeof message.message !== "string") return;
    const separator = message.message.indexOf(":");
    if (separator < 1) return;
    const channel = message.message.slice(0, separator);
    if (channel !== "A" && channel !== "B") return;
    let payload: unknown;
    try { payload = JSON.parse(message.message.slice(separator + 1)); } catch { return; }
    if (!Array.isArray(payload) || payload.some((item) => typeof item !== "string" || hexBytes(item) === null)) return;
    this.#stopWaveform();
    this.#waveformChannel = channel;
    this.#waveformPayload = payload as string[];
    this.#waveformIndex = 0;
    this.#queueFrame();
    const durationMs = Math.max(100, Math.floor(message.durationMs ?? (message.time ?? 1) * 1_000));
    this.#waveformTimer = setInterval(() => this.#queueFrame(), 100);
    this.#waveformStopTimer = setTimeout(() => this.#stopWaveform(), durationMs);
  }

  setSafetyLimit(strength: number): void {
    this.#maxStrength = clampStrength(strength);
    if (this.#status === "paired") this.#queueWrite(softLimitFrame(this.#maxStrength));
  }

  subscribe(listener: MessageListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #connect(generation: number): Promise<void> {
    if (this.#adapter === undefined) throw new Error("当前浏览器不支持 Web Bluetooth，或页面不是 HTTPS。");
    const device = await this.#adapter.requestDevice({ filters: [{ namePrefix: "47L121000" }], optionalServices: [DGLAB_BLUETOOTH_SERVICE_UUID] });
    if (generation !== this.#generation) return;
    const server = await device.gatt?.connect();
    if (server === undefined) throw new Error("无法建立 DG-LAB GATT 连接。");
    const service = await server.getPrimaryService(DGLAB_BLUETOOTH_SERVICE_UUID);
    const write = await service.getCharacteristic(DGLAB_BLUETOOTH_WRITE_UUID);
    const notify = await service.getCharacteristic(DGLAB_BLUETOOTH_NOTIFY_UUID);
    await notify.startNotifications();
    if (generation !== this.#generation) { server.disconnect(); return; }
    this.#device = device;
    this.#server = server;
    this.#writeCharacteristic = write;
    this.#notifyCharacteristic = notify;
    notify.addEventListener("characteristicvaluechanged", this.#onNotification);
    device.addEventListener("gattserverdisconnected", this.#onDisconnected);
    await this.#writeBytes(softLimitFrame(this.#maxStrength));
    this.#setStatus("paired");
    this.#emit({ type: "msg", message: `strength-0+0+${this.#maxStrength}+${this.#maxStrength}` });
  }

  async #writeBytes(bytes: Uint8Array): Promise<void> {
    const characteristic = this.#writeCharacteristic;
    if (characteristic === null) throw new Error("DG-LAB 蓝牙写入特性不可用。");
    const value = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    if (characteristic.writeValueWithResponse !== undefined) await characteristic.writeValueWithResponse(value);
    else if (characteristic.writeValue !== undefined) await characteristic.writeValue(value);
    else throw new Error("DG-LAB 蓝牙写入方法不可用。");
  }

  #queueWrite(bytes: Uint8Array): void {
    this.#writeQueue = this.#writeQueue.catch(() => undefined).then(() => this.#writeBytes(bytes)).catch(() => {
      if (this.#status !== "offline") this.#setStatus("error");
    });
  }

  #queueFrame(): void {
    const active = this.#waveformPayload[this.#waveformIndex % Math.max(1, this.#waveformPayload.length)];
    this.#waveformIndex += 1;
    const a = this.#waveformChannel === "A" ? hexBytes(active ?? "") : null;
    const b = this.#waveformChannel === "B" ? hexBytes(active ?? "") : null;
    const frame = new Uint8Array(20);
    frame[0] = 0xB0;
    frame[1] = 0x0F;
    frame[2] = byte(this.#strengthA);
    frame[3] = byte(this.#strengthB);
    frame.set(a === null ? INVALID_WAVEFORM.frequencies : a.slice(0, 4), 4);
    frame.set(a === null ? INVALID_WAVEFORM.intensities : a.slice(4, 8), 8);
    frame.set(b === null ? INVALID_WAVEFORM.frequencies : b.slice(0, 4), 12);
    frame.set(b === null ? INVALID_WAVEFORM.intensities : b.slice(4, 8), 16);
    this.#queueWrite(frame);
  }

  #receive(value: DataView | undefined): void {
    if (value === undefined || value.byteLength < 4 || value.getUint8(0) !== 0xB1) return;
    this.#emit({ type: "msg", message: `strength-${value.getUint8(2)}+${value.getUint8(3)}+${this.#maxStrength}+${this.#maxStrength}` });
  }

  #stopWaveform(): void {
    if (this.#waveformTimer !== null) clearInterval(this.#waveformTimer);
    if (this.#waveformStopTimer !== null) clearTimeout(this.#waveformStopTimer);
    this.#waveformTimer = null;
    this.#waveformStopTimer = null;
    this.#waveformPayload = [];
    this.#waveformIndex = 0;
  }

  #handleDisconnected(): void {
    this.#stopWaveform();
    this.#writeCharacteristic = null;
    this.#notifyCharacteristic = null;
    this.#server = null;
    this.#device = null;
    this.#setStatus("offline");
  }

  #setStatus(status: DgLabConnectionStatus): void {
    this.#status = status;
    this.#onStatus(status, null);
  }

  #emit(message: DgLabTransportMessage): void {
    for (const listener of this.#listeners) listener(message);
  }
}
