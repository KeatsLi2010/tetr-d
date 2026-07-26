import {
  PLAYER_ACTIONS,
  type PlayerActionName
} from "../playerConfigTypes.ts";
import {
  migratePlayerConfig as migrateV2
} from "../playerConfigMigration.ts";
import {
  normalizePlayerConfig as normalizeV2
} from "../playerConfig.ts";

export { PLAYER_ACTIONS };
export type { PlayerActionName };

export const PLAYER_CONFIG_VERSION = 3 as const;
export const PLAYER_CONFIG_STORAGE_KEY = "tetr-d.player-config.v3";
export type BufferMode = "off" | "hold" | "tap";
export type SoftDropFactor = number | "sonic";
export type PlayerKeyBindings = Readonly<
  Record<PlayerActionName, readonly string[]>
>;

export interface PlayerHandlingConfig {
  readonly arrFrameTenths: number;
  readonly dasFrameTenths: number;
  readonly dcdFrameTenths: number;
  readonly sdf: SoftDropFactor;
  readonly dasCancellation: boolean;
  readonly safeLock: boolean;
  readonly preferSoftDrop: boolean;
  readonly irs: BufferMode;
  readonly ihs: BufferMode;
}

export interface PlayerConfig {
  readonly version: typeof PLAYER_CONFIG_VERSION;
  readonly bindings: PlayerKeyBindings;
  readonly handling: PlayerHandlingConfig;
}

export const HANDLING_RANGES = Object.freeze({
  arrFrameTenths: Object.freeze({ min: 0, max: 50 }),
  dasFrameTenths: Object.freeze({ min: 10, max: 200 }),
  dcdFrameTenths: Object.freeze({ min: 0, max: 200 }),
  sdf: Object.freeze({ min: 5, max: 40 })
});

/** IRS/IHS default to "hold" as this project's explicit local policy. */
export const DEFAULT_PLAYER_CONFIG: PlayerConfig = Object.freeze({
  version: PLAYER_CONFIG_VERSION,
  bindings: Object.freeze({
    moveLeft: Object.freeze(["ArrowLeft", "Numpad4"]),
    moveRight: Object.freeze(["ArrowRight", "Numpad6"]),
    softDrop: Object.freeze(["ArrowDown", "Numpad2"]),
    hardDrop: Object.freeze(["Space", "Numpad8"]),
    rotateCW: Object.freeze(["ArrowUp", "KeyX", "Numpad1"]),
    rotateCCW: Object.freeze(["ControlLeft", "KeyZ", "Numpad3"]),
    rotate180: Object.freeze(["KeyA"]),
    hold: Object.freeze(["ShiftLeft", "KeyC", "Numpad0"]),
    forfeit: Object.freeze(["Escape"]),
    retry: Object.freeze(["KeyR"]),
    openChat: Object.freeze(["KeyT"])
  }),
  handling: Object.freeze({
    arrFrameTenths: 20,
    dasFrameTenths: 100,
    dcdFrameTenths: 0,
    sdf: 6,
    dasCancellation: false,
    safeLock: true,
    preferSoftDrop: false,
    irs: "hold",
    ihs: "hold"
  })
});

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rangedInteger(
  value: unknown,
  range: Readonly<{ min: number; max: number }>
): value is number {
  return Number.isInteger(value) &&
    (value as number) >= range.min &&
    (value as number) <= range.max;
}

function keyList(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > 3 ||
    !value.every((key) =>
      typeof key === "string" &&
      key.length > 0 &&
      key.length <= 64 &&
      key.trim() === key
    ) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return Object.freeze([...value]);
}

export function normalizePlayerConfig(value: unknown): PlayerConfig | null {
  const source = record(value);
  const handling = record(source?.handling);
  const bindingSource = record(source?.bindings);
  if (
    source?.version !== PLAYER_CONFIG_VERSION ||
    handling === null ||
    bindingSource === null
  ) {
    return null;
  }
  const bindings = {} as Record<PlayerActionName, readonly string[]>;
  for (const action of PLAYER_ACTIONS) {
    const keys = keyList(bindingSource[action]);
    if (keys === null) return null;
    bindings[action] = keys;
  }
  const {
    arrFrameTenths,
    dasFrameTenths,
    dcdFrameTenths,
    sdf,
    dasCancellation,
    safeLock,
    preferSoftDrop,
    irs,
    ihs
  } = handling;
  const buffers = ["off", "hold", "tap"];
  if (
    !rangedInteger(arrFrameTenths, HANDLING_RANGES.arrFrameTenths) ||
    !rangedInteger(dasFrameTenths, HANDLING_RANGES.dasFrameTenths) ||
    !rangedInteger(dcdFrameTenths, HANDLING_RANGES.dcdFrameTenths) ||
    !(sdf === "sonic" || rangedInteger(sdf, HANDLING_RANGES.sdf)) ||
    ![dasCancellation, safeLock, preferSoftDrop]
      .every((flag) => typeof flag === "boolean") ||
    !buffers.includes(irs as string) ||
    !buffers.includes(ihs as string)
  ) {
    return null;
  }
  return Object.freeze({
    version: PLAYER_CONFIG_VERSION,
    bindings: Object.freeze(bindings),
    handling: Object.freeze({
      arrFrameTenths,
      dasFrameTenths,
      dcdFrameTenths,
      sdf: sdf as SoftDropFactor,
      dasCancellation: dasCancellation as boolean,
      safeLock: safeLock as boolean,
      preferSoftDrop: preferSoftDrop as boolean,
      irs: irs as BufferMode,
      ihs: ihs as BufferMode
    })
  });
}

export function bindingConflicts(
  bindings: PlayerKeyBindings
): ReadonlyMap<string, readonly PlayerActionName[]> {
  const owners = new Map<string, PlayerActionName[]>();
  for (const action of PLAYER_ACTIONS) {
    for (const code of bindings[action]) {
      const list = owners.get(code) ?? [];
      list.push(action);
      owners.set(code, list);
    }
  }
  return new Map(
    [...owners].filter(([, list]) => list.length > 1).map(
      ([code, list]) => [code, Object.freeze([...list])] as const
    )
  );
}

function buffer(value: unknown): BufferMode {
  if (value === "off" || value === "hold" || value === "tap") return value;
  if (value === false) return "off";
  return "hold";
}

export function migratePlayerConfig(value: unknown): {
  readonly value: unknown;
  readonly migrated: boolean;
} {
  const source = record(value);
  if (source?.version === PLAYER_CONFIG_VERSION) {
    return { value, migrated: false };
  }
  const v2Migration = migrateV2(value);
  const v2 = normalizeV2(v2Migration.value);
  if (v2 === null) return { value, migrated: false };
  const oldBindings =
    record(source?.bindings) ?? record(source?.keyBindings) ?? {};
  const bindings = { ...v2.bindings };
  for (const action of ["forfeit", "retry", "openChat"] as const) {
    if (oldBindings[action] === undefined) {
      bindings[action] = DEFAULT_PLAYER_CONFIG.bindings[action];
    }
  }
  return {
    migrated: true,
    value: {
      version: PLAYER_CONFIG_VERSION,
      bindings,
      handling: {
        ...v2.handling,
        irs: buffer(record(source?.handling)?.irs),
        ihs: buffer(record(source?.handling)?.ihs)
      }
    }
  };
}

export function frameTenthsToMs(frameTenths: number): number {
  return frameTenths * (1_000 / 600);
}

