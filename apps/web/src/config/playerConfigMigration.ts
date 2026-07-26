import {
  DEFAULT_PLAYER_CONFIG,
  HANDLING_RANGES
} from "./playerConfig.ts";
import {
  PLAYER_ACTIONS,
  PLAYER_CONFIG_VERSION,
  SONIC_SDF_SENTINEL,
  msToFrameTenths,
  type PlayerActionName
} from "./playerConfigTypes.ts";

export interface PlayerConfigMigration {
  readonly value: unknown;
  readonly migrated: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function migratedBindings(value: unknown): Record<PlayerActionName, unknown> {
  const source = record(value) ?? {};
  const result = {} as Record<PlayerActionName, unknown>;
  for (const action of PLAYER_ACTIONS) {
    const candidate = source[action];
    const list = typeof candidate === "string" ? [candidate] : candidate;
    result[action] = Array.isArray(list)
      ? list.slice(0, 3)
      : DEFAULT_PLAYER_CONFIG.bindings[action];
  }
  return result;
}

function oldTiming(
  handling: Record<string, unknown>,
  millisecondsName: string,
  frameTenthsName: string,
  fallback: number,
  min: number,
  max: number
): number {
  const exact = handling[frameTenthsName];
  if (typeof exact === "number" && Number.isFinite(exact)) {
    return clamp(Math.round(exact), min, max);
  }
  const milliseconds = handling[millisecondsName];
  if (typeof milliseconds === "number" && Number.isFinite(milliseconds)) {
    return clamp(msToFrameTenths(milliseconds), min, max);
  }
  return fallback;
}

function migrateOlder(value: Record<string, unknown>): unknown {
  const handling = record(value.handling) ?? {};
  const sdfValue = handling.sdf;
  const sdf = sdfValue === "sonic" || sdfValue === SONIC_SDF_SENTINEL
    ? "sonic"
    : typeof sdfValue === "number" &&
        sdfValue >= HANDLING_RANGES.sdf.min &&
        sdfValue <= HANDLING_RANGES.sdf.max
      ? Math.round(sdfValue)
      : DEFAULT_PLAYER_CONFIG.handling.sdf;
  return {
    version: PLAYER_CONFIG_VERSION,
    bindings: migratedBindings(value.keyBindings ?? value.bindings),
    handling: {
      arrFrameTenths: oldTiming(
        handling, "arrMs", "arrFrameTenths", 20, 0, 50
      ),
      dasFrameTenths: oldTiming(
        handling, "dasMs", "dasFrameTenths", 100, 10, 200
      ),
      dcdFrameTenths: oldTiming(
        handling, "dcdMs", "dcdFrameTenths", 0, 0, 200
      ),
      sdf,
      dasCancellation: handling.dasCancellation ?? false,
      safeLock: handling.safeLock ?? handling.safelock ?? true,
      preferSoftDrop: handling.preferSoftDrop ?? false,
      irs: handling.irs ?? true,
      ihs: handling.ihs ?? true
    }
  };
}

export function migratePlayerConfig(value: unknown): PlayerConfigMigration {
  const source = record(value);
  if (source === null || source.version === PLAYER_CONFIG_VERSION) {
    return { value, migrated: false };
  }
  if (
    source.version === undefined ||
    source.version === 0 ||
    source.version === 1
  ) {
    return { value: migrateOlder(source), migrated: true };
  }
  return { value, migrated: false };
}

