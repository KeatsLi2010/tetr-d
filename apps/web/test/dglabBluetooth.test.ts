import assert from "node:assert/strict";
import test from "node:test";

import {
  DGLAB_BLUETOOTH_NOTIFY_UUID,
  DGLAB_BLUETOOTH_SERVICE_UUID,
  DGLAB_BLUETOOTH_WRITE_UUID,
  DgLabBluetoothTransport
} from "../src/dglab/index.ts";
import type {
  DgLabBluetoothAdapter,
  DgLabBluetoothCharacteristic,
  DgLabBluetoothDevice,
  DgLabBluetoothServer,
  DgLabBluetoothService
} from "../src/dglab/index.ts";
import type { DgLabTransportMessage } from "../src/dglab/index.ts";

class FakeCharacteristic implements DgLabBluetoothCharacteristic {
  readonly writes: Uint8Array[] = [];
  readonly listeners = new Set<(event: { readonly target?: { readonly value?: DataView } }) => void>();
  responseAttempts = 0;
  readonly writeValueWithoutResponse = async (value: BufferSource): Promise<void> => {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.writes.push(new Uint8Array(bytes));
  };
  readonly writeValueWithResponse = async (_value: BufferSource): Promise<void> => {
    this.responseAttempts += 1;
    throw new Error("response write should not be used");
  };
  async startNotifications(): Promise<DgLabBluetoothCharacteristic> { return this; }
  addEventListener(_type: "characteristicvaluechanged", listener: (event: { readonly target?: { readonly value?: DataView } }) => void): void { this.listeners.add(listener); }
  emit(bytes: number[]): void {
    const value = new DataView(Uint8Array.from(bytes).buffer);
    for (const listener of this.listeners) listener({ target: { value } });
  }
}

class FakeService implements DgLabBluetoothService {
  readonly write: FakeCharacteristic;
  readonly notify: FakeCharacteristic;
  constructor(write: FakeCharacteristic, notify: FakeCharacteristic) { this.write = write; this.notify = notify; }
  getCharacteristic(uuid: string): Promise<DgLabBluetoothCharacteristic> {
    return Promise.resolve(uuid === DGLAB_BLUETOOTH_WRITE_UUID ? this.write : this.notify);
  }
}

class FakeServer implements DgLabBluetoothServer {
  readonly service: FakeService;
  constructor(service: FakeService) { this.service = service; }
  getPrimaryService(uuid: string): Promise<DgLabBluetoothService> {
    assert.equal(uuid, DGLAB_BLUETOOTH_SERVICE_UUID);
    return Promise.resolve(this.service);
  }
  disconnect(): void {}
}

class FakeDevice implements DgLabBluetoothDevice {
  readonly id = "device-1";
  readonly name = "47L121000";
  readonly listeners = new Set<() => void>();
  readonly server: FakeServer;
  constructor(server: FakeServer) { this.server = server; }
  readonly gatt = { connect: async (): Promise<DgLabBluetoothServer> => this.server };
  addEventListener(_type: "gattserverdisconnected", listener: () => void): void { this.listeners.add(listener); }
  disconnect(): void { for (const listener of this.listeners) listener(); }
}

class FakeAdapter implements DgLabBluetoothAdapter {
  readonly device: FakeDevice;
  requests = 0;
  readonly grantedDevices: FakeDevice[] = [];
  constructor(write: FakeCharacteristic, notify: FakeCharacteristic) {
    this.device = new FakeDevice(new FakeServer(new FakeService(write, notify)));
  }
  getDevices(): Promise<readonly DgLabBluetoothDevice[]> { return Promise.resolve(this.grantedDevices); }
  requestDevice(options: { readonly filters: readonly [{ readonly namePrefix: string }]; readonly optionalServices: readonly [string] }): Promise<DgLabBluetoothDevice> {
    this.requests += 1;
    assert.equal(options.filters[0].namePrefix, "47L121000");
    assert.deepEqual(options.optionalServices, [DGLAB_BLUETOOTH_SERVICE_UUID]);
    return Promise.resolve(this.device);
  }
}

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("Bluetooth transport writes V3 BF/B0 frames and parses B1 readings", async () => {
  const write = new FakeCharacteristic();
  const notify = new FakeCharacteristic();
  const adapter = new FakeAdapter(write, notify);
  const messages: DgLabTransportMessage[] = [];
  const statuses: string[] = [];
  const transport = new DgLabBluetoothTransport({ maxStrength: 30, adapter }, (status) => statuses.push(status));
  transport.subscribe((message) => messages.push(message));
  transport.connect();
  await flush();
  assert.equal(transport.status, "paired");
  assert.equal(write.responseAttempts, 0);
  assert.deepEqual(Array.from(write.writes[0] ?? []), [0xBF, 30, 30, 0, 0, 0, 0]);
  transport.send({ type: 3, channel: 1, strength: 12 });
  await flush();
  assert.equal(write.writes.filter((item) => item[0] === 0xB0).length, 0);
  transport.send({ type: "clientMsg", channel: "A", durationMs: 110, message: 'A:["0C0C0C0C000A141E"]' });
  await flush();
  const frame = write.writes.find((item) => item[0] === 0xB0 && item[2] === 12 && item[8] === 0);
  assert.ok(frame);
  assert.equal(frame[1], 0x0F);
  assert.equal(frame[2], 12);
  assert.equal(frame[3], 0);
  assert.deepEqual(Array.from(frame.slice(4, 12)), [12, 12, 12, 12, 0, 10, 20, 30]);
  assert.deepEqual(Array.from(frame.slice(16, 20)), [101, 101, 101, 101]);
  transport.send({ type: "clientMsg", channel: "B", durationMs: 110, message: 'B:["1414141450505050"]' });
  await flush();
  const dualFrame = write.writes.find((item) => item[0] === 0xB0 && item.slice(4, 12).every((value) => value !== 101) && item.slice(12, 20).every((value) => value !== 101));
  assert.ok(dualFrame, "A and B waveforms should coexist in one B0 frame");
  assert.deepEqual(Array.from(dualFrame!.slice(12, 20)), [20, 20, 20, 20, 80, 80, 80, 80]);
  notify.emit([0xB1, 0, 12, 7]);
  assert.deepEqual(messages.at(-1), { type: "msg", message: "strength-12+7+30+30" });
  transport.setSafetyLimit?.(45);
  await flush();
  assert.deepEqual(Array.from(write.writes.at(-1) ?? []), [0xBF, 45, 45, 0, 0, 0, 0]);
  transport.close();
  assert.equal(transport.status, "offline");
  assert.ok(statuses.includes("connecting") && statuses.includes("paired"));
});

test("Bluetooth transport restores a granted device from local metadata", async () => {
  const storage = new MemoryStorage();
  const firstAdapter = new FakeAdapter(new FakeCharacteristic(), new FakeCharacteristic());
  const first = new DgLabBluetoothTransport({ maxStrength: 30, adapter: firstAdapter, storage });
  first.connect();
  await flush();
  assert.equal(firstAdapter.requests, 1);
  first.close();

  const secondAdapter = new FakeAdapter(new FakeCharacteristic(), new FakeCharacteristic());
  secondAdapter.grantedDevices.push(secondAdapter.device);
  const second = new DgLabBluetoothTransport({ maxStrength: 30, adapter: secondAdapter, storage });
  second.connect();
  await flush();
  assert.equal(second.status, "paired");
  assert.equal(secondAdapter.requests, 0);
  second.close();

  second.connect(true);
  await flush();
  assert.equal(secondAdapter.requests, 1);
  second.close();
});
