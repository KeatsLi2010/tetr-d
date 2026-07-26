import assert from "node:assert/strict";
import test from "node:test";

import {
  clearRememberedDgLabDevice,
  loadRememberedDgLabDevice,
  saveRememberedDgLabDevice
} from "../src/dglab/index.ts";
import type { DgLabDeviceStorage } from "../src/dglab/index.ts";

class MemoryStorage implements DgLabDeviceStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

test("DG-LAB remembered device survives reload with only local metadata", () => {
  const storage = new MemoryStorage();
  assert.equal(saveRememberedDgLabDevice(storage, { id: "device-1", name: "47L121000" }, 1234), true);
  assert.deepEqual(loadRememberedDgLabDevice(storage), {
    version: 1,
    id: "device-1",
    name: "47L121000",
    savedAt: 1234
  });
  clearRememberedDgLabDevice(storage);
  assert.equal(loadRememberedDgLabDevice(storage), null);
});

test("DG-LAB remembered device rejects malformed or oversized metadata", () => {
  const storage = new MemoryStorage();
  storage.setItem("tetr-d.dglab-device.v1", JSON.stringify({ version: 1, id: "", name: null, savedAt: 1 }));
  assert.equal(loadRememberedDgLabDevice(storage), null);
  storage.setItem("tetr-d.dglab-device.v1", JSON.stringify({ version: 2, id: "device-1", name: null, savedAt: 1 }));
  assert.equal(loadRememberedDgLabDevice(storage), null);
});
