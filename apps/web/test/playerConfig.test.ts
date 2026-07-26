import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PLAYER_CONFIG,
  bindingConflicts,
  normalizePlayerConfig
} from "../src/config/v3/index.ts";
import { migratePlayerConfig } from "../src/config/v3/index.ts";
import {
  loadLocalConfig,
  saveLocalConfig
} from "../src/config/v3/index.ts";
import type { StorageLike } from "../src/config/v3/index.ts";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test("default config uses the researched frame-tenths values", () => {
  assert.deepEqual(DEFAULT_PLAYER_CONFIG.handling, {
    arrFrameTenths: 20,
    dasFrameTenths: 100,
    dcdFrameTenths: 0,
    sdf: 6,
    dasCancellation: false,
    safeLock: true,
    preferSoftDrop: false,
    irs: "hold",
    ihs: "hold"
  });
  assert.notEqual(normalizePlayerConfig(DEFAULT_PLAYER_CONFIG), null);
});

test("bindings allow three slots and report cross-action conflicts", () => {
  const config = {
    ...DEFAULT_PLAYER_CONFIG,
    bindings: {
      ...DEFAULT_PLAYER_CONFIG.bindings,
      moveLeft: ["KeyA", "KeyB", "KeyC"],
      hold: ["KeyA"]
    }
  };
  const normalized = normalizePlayerConfig(config);
  assert.notEqual(normalized, null);
  assert.deepEqual(
    bindingConflicts(normalized!.bindings).get("KeyA"),
    ["moveLeft", "rotate180", "hold"]
  );
  assert.equal(normalizePlayerConfig({
    ...config,
    bindings: { ...config.bindings, moveLeft: ["A", "B", "C", "D"] }
  }), null);
});

test("v1 millisecond config migrates and fills newer actions", () => {
  const migration = migratePlayerConfig({
    version: 1,
    bindings: {
      moveLeft: ["KeyQ"],
      moveRight: ["KeyE"],
      softDrop: ["KeyS"],
      hardDrop: ["Space"],
      rotateCW: ["KeyX"],
      rotateCCW: ["KeyZ"],
      rotate180: ["KeyA"],
      hold: ["ShiftLeft"]
    },
    handling: { arrMs: 25, dasMs: 100, dcdMs: 50, sdf: 41 }
  });
  assert.equal(migration.migrated, true);
  const normalized = normalizePlayerConfig(migration.value);
  assert.notEqual(normalized, null);
  assert.equal(normalized!.handling.arrFrameTenths, 15);
  assert.equal(normalized!.handling.dasFrameTenths, 60);
  assert.equal(normalized!.handling.dcdFrameTenths, 30);
  assert.equal(normalized!.handling.sdf, "sonic");
  assert.deepEqual(normalized!.bindings.forfeit, ["Escape"]);
});

test("storage falls back safely and persists normalized configs", () => {
  const storage = new MemoryStorage();
  assert.equal(loadLocalConfig(storage).source, "default");
  storage.setItem("tetr-d.player-config.v3", "{broken");
  assert.equal(loadLocalConfig(storage).source, "default");

  assert.equal(saveLocalConfig(storage, DEFAULT_PLAYER_CONFIG), true);
  const loaded = loadLocalConfig(storage);
  assert.equal(loaded.source, "stored");
  assert.deepEqual(loaded.config, DEFAULT_PLAYER_CONFIG);
  assert.throws(
    () => saveLocalConfig(storage, { version: 3 }),
    /Invalid player config/
  );
});

