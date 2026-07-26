export const PLAYER_CONFIG_VERSION = 2 as const;
export const PLAYER_CONFIG_STORAGE_KEY = "tetr-d.player-config.v2";
export const SONIC_SDF_SENTINEL = 41 as const;

export const PLAYER_ACTIONS = [
  "moveLeft",
  "moveRight",
  "softDrop",
  "hardDrop",
  "rotateCW",
  "rotateCCW",
  "rotate180",
  "hold",
  "forfeit",
  "retry",
  "openChat"
] as const;

export type PlayerActionName = (typeof PLAYER_ACTIONS)[number];
export type PlayerKeyBindings = Readonly<
  Record<PlayerActionName, readonly string[]>
>;
export type SoftDropFactor = number | "sonic";

/**
 * ARR/DAS/DCD use tenths of a 60 Hz frame. Integers avoid floating-point
 * drift while preserving TETR.IO's 0.1F UI step.
 */
export interface PlayerHandlingConfig {
  readonly arrFrameTenths: number;
  readonly dasFrameTenths: number;
  readonly dcdFrameTenths: number;
  readonly sdf: SoftDropFactor;
  readonly dasCancellation: boolean;
  readonly safeLock: boolean;
  readonly preferSoftDrop: boolean;
  readonly irs: boolean;
  readonly ihs: boolean;
}

export interface PlayerConfig {
  readonly version: typeof PLAYER_CONFIG_VERSION;
  readonly bindings: PlayerKeyBindings;
  readonly handling: PlayerHandlingConfig;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function frameTenthsToMs(frameTenths: number): number {
  return frameTenths * (1_000 / 600);
}

export function msToFrameTenths(milliseconds: number): number {
  return Math.round(milliseconds * (600 / 1_000));
}

