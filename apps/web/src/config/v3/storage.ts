import {
  DEFAULT_PLAYER_CONFIG,
  PLAYER_CONFIG_STORAGE_KEY,
  migratePlayerConfig,
  normalizePlayerConfig,
  type PlayerConfig
} from "./model.ts";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LocalConfigLoadResult {
  readonly config: PlayerConfig;
  readonly source: "default" | "stored" | "migrated";
}

export function loadLocalConfig(
  storage: StorageLike,
  key = PLAYER_CONFIG_STORAGE_KEY
): LocalConfigLoadResult {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { config: DEFAULT_PLAYER_CONFIG, source: "default" };
  }
  if (raw === null) {
    return { config: DEFAULT_PLAYER_CONFIG, source: "default" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: DEFAULT_PLAYER_CONFIG, source: "default" };
  }
  const migration = migratePlayerConfig(parsed);
  const config = normalizePlayerConfig(migration.value);
  if (config === null) {
    return { config: DEFAULT_PLAYER_CONFIG, source: "default" };
  }
  if (migration.migrated) saveLocalConfig(storage, config, key);
  return {
    config,
    source: migration.migrated ? "migrated" : "stored"
  };
}

export function saveLocalConfig(
  storage: StorageLike,
  value: unknown,
  key = PLAYER_CONFIG_STORAGE_KEY
): boolean {
  const config = normalizePlayerConfig(value);
  if (config === null) throw new TypeError("Invalid player config.");
  try {
    storage.setItem(key, JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
}

export function resetLocalConfig(
  storage: StorageLike,
  key = PLAYER_CONFIG_STORAGE_KEY
): PlayerConfig {
  try {
    storage.removeItem(key);
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }
  return DEFAULT_PLAYER_CONFIG;
}

