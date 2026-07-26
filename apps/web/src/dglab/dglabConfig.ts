import type { DgLabConfig } from "./dglabTypes.ts";
import { normalizeCustomWaveform } from "./dglabWaveforms.ts";

export const DGLAB_CONFIG_VERSION = 1 as const;
export const DGLAB_CONFIG_STORAGE_KEY = "tetr-d.dglab-config.v1";
export const DGLAB_ABSOLUTE_MAX_STRENGTH = 200;

export const DEFAULT_DGLAB_CONFIG: DgLabConfig = Object.freeze({
  version: DGLAB_CONFIG_VERSION,
  enabled: false,
  waveform: "breath",
  customWaveform: Object.freeze([]),
  channel: "A",
  maxStrength: 30,
  baseStrength: 4,
  strengthPerPoint: 3,
  baseDurationMs: 250,
  durationPerPointMs: 80,
  cooldownMs: 750,
  maxQueueSeconds: 8,
  weights: Object.freeze({
    b2bBreak: 5,
    b2bContinue: 2,
    combo: 1,
    attackReceived: 2,
    attackCancelled: 2
  })
});

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function normalizeDgLabConfig(value: unknown): DgLabConfig | null {
  const source = record(value);
  const weights = record(source?.weights);
  if (source?.version !== DGLAB_CONFIG_VERSION || weights === null) return null;
  if (typeof source.enabled !== "boolean") return null;
  if (source.waveform !== "breath" && source.waveform !== "tide" && source.waveform !== "custom") return null;
  const customWaveform = normalizeCustomWaveform(source.customWaveform ?? []);
  if (source.waveform === "custom" && customWaveform === null) return null;
  if (source.channel !== "A" && source.channel !== "B") return null;
  if (!numberInRange(source.maxStrength, 0, DGLAB_ABSOLUTE_MAX_STRENGTH)) return null;
  if (!numberInRange(source.baseStrength, 0, DGLAB_ABSOLUTE_MAX_STRENGTH)) return null;
  if (!numberInRange(source.strengthPerPoint, 0, DGLAB_ABSOLUTE_MAX_STRENGTH)) return null;
  if (!numberInRange(source.baseDurationMs, 100, 5_000)) return null;
  if (!numberInRange(source.durationPerPointMs, 0, 2_000)) return null;
  if (!numberInRange(source.cooldownMs, 250, 10_000)) return null;
  if (!numberInRange(source.maxQueueSeconds, 1, 30)) return null;
  for (const key of ["b2bBreak", "b2bContinue", "combo", "attackReceived", "attackCancelled"] as const) {
    if (!numberInRange(weights[key], 0, 20)) return null;
  }
  return Object.freeze({
    version: 1,
    enabled: source.enabled,
    waveform: source.waveform,
    customWaveform: customWaveform ?? Object.freeze([]),
    channel: source.channel,
    maxStrength: Math.floor(source.maxStrength),
    baseStrength: Math.floor(source.baseStrength),
    strengthPerPoint: Math.floor(source.strengthPerPoint),
    baseDurationMs: Math.floor(source.baseDurationMs),
    durationPerPointMs: Math.floor(source.durationPerPointMs),
    cooldownMs: Math.floor(source.cooldownMs),
    maxQueueSeconds: Math.floor(source.maxQueueSeconds),
    weights: Object.freeze({
      b2bBreak: weights.b2bBreak as number,
      b2bContinue: weights.b2bContinue as number,
      combo: weights.combo as number,
      attackReceived: weights.attackReceived as number,
      attackCancelled: weights.attackCancelled as number
    })
  });
}

export function loadDgLabConfig(
  storage: StorageLike,
  key = DGLAB_CONFIG_STORAGE_KEY
): DgLabConfig {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return DEFAULT_DGLAB_CONFIG;
    return normalizeDgLabConfig(JSON.parse(raw)) ?? DEFAULT_DGLAB_CONFIG;
  } catch {
    return DEFAULT_DGLAB_CONFIG;
  }
}

export function saveDgLabConfig(
  storage: StorageLike,
  value: unknown,
  key = DGLAB_CONFIG_STORAGE_KEY
): boolean {
  const config = normalizeDgLabConfig(value);
  if (config === null) throw new TypeError("Invalid DG-LAB config.");
  try {
    storage.setItem(key, JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
}

export function resetDgLabConfig(
  storage: StorageLike,
  key = DGLAB_CONFIG_STORAGE_KEY
): DgLabConfig {
  try { storage.removeItem(key); } catch { /* private browsing */ }
  return DEFAULT_DGLAB_CONFIG;
}
