export const DGLAB_DEVICE_STORAGE_KEY = "tetr-d.dglab-device.v1";
export const DGLAB_DEVICE_STORAGE_VERSION = 1 as const;

export interface DgLabRememberedDevice {
  readonly version: 1;
  readonly id: string;
  readonly name: string | null;
  readonly savedAt: number;
}

export interface DgLabDeviceStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value: unknown): DgLabRememberedDevice | null {
  if (!isRecord(value) || value.version !== DGLAB_DEVICE_STORAGE_VERSION) return null;
  if (typeof value.id !== "string" || value.id.trim().length === 0) return null;
  if (value.name !== null && typeof value.name !== "string") return null;
  if (typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt) || value.savedAt < 0) return null;
  return Object.freeze({
    version: DGLAB_DEVICE_STORAGE_VERSION,
    id: value.id,
    name: value.name,
    savedAt: Math.floor(value.savedAt)
  });
}

export function loadRememberedDgLabDevice(
  storage: DgLabDeviceStorage,
  key = DGLAB_DEVICE_STORAGE_KEY
): DgLabRememberedDevice | null {
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : normalize(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveRememberedDgLabDevice(
  storage: DgLabDeviceStorage,
  device: Omit<DgLabRememberedDevice, "version" | "savedAt">,
  now = Date.now(),
  key = DGLAB_DEVICE_STORAGE_KEY
): boolean {
  const value = normalize({ ...device, version: DGLAB_DEVICE_STORAGE_VERSION, savedAt: now });
  if (value === null) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clearRememberedDgLabDevice(
  storage: DgLabDeviceStorage,
  key = DGLAB_DEVICE_STORAGE_KEY
): void {
  try { storage.removeItem(key); } catch { /* private browsing */ }
}
