import {
  PLAYER_ACTIONS,
  PLAYER_CONFIG_VERSION,
  type PlayerActionName,
  type PlayerConfig,
  type PlayerHandlingConfig,
  type PlayerKeyBindings
} from "./playerConfigTypes.ts";

export const HANDLING_RANGES = Object.freeze({
  arrFrameTenths: Object.freeze({ min: 0, max: 50 }),
  dasFrameTenths: Object.freeze({ min: 10, max: 200 }),
  dcdFrameTenths: Object.freeze({ min: 0, max: 200 }),
  sdf: Object.freeze({ min: 5, max: 40 })
});

export const DEFAULT_PLAYER_CONFIG: PlayerConfig = Object.freeze({
  version: PLAYER_CONFIG_VERSION,
  bindings: Object.freeze({
    moveLeft: Object.freeze(["ArrowLeft"]),
    moveRight: Object.freeze(["ArrowRight"]),
    softDrop: Object.freeze(["ArrowDown"]),
    hardDrop: Object.freeze(["Space"]),
    rotateCW: Object.freeze(["ArrowUp", "KeyX"]),
    rotateCCW: Object.freeze(["KeyZ"]),
    rotate180: Object.freeze(["KeyA"]),
    hold: Object.freeze(["ShiftLeft", "KeyC"]),
    forfeit: Object.freeze([]),
    retry: Object.freeze([]),
    openChat: Object.freeze(["Enter"])
  }),
  handling: Object.freeze({
    arrFrameTenths: 20,
    dasFrameTenths: 100,
    dcdFrameTenths: 0,
    sdf: 6,
    dasCancellation: false,
    safeLock: true,
    preferSoftDrop: false,
    irs: true,
    ihs: true
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
  if (!Array.isArray(value) || value.length > 3) return null;
  if (!value.every((key) =>
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= 64 &&
    key.trim() === key
  )) {
    return null;
  }
  return new Set(value).size === value.length
    ? Object.freeze([...value])
    : null;
}

export function normalizePlayerKeyBindings(
  value: unknown
): PlayerKeyBindings | null {
  const source = record(value);
  if (source === null) return null;
  const normalized =
    {} as Record<PlayerActionName, readonly string[]>;
  for (const action of PLAYER_ACTIONS) {
    const keys = keyList(source[action]);
    if (keys === null) return null;
    normalized[action] = keys;
  }
  return Object.freeze(normalized);
}

export function bindingConflicts(
  bindings: PlayerKeyBindings
): ReadonlyMap<string, readonly PlayerActionName[]> {
  const codes = new Map<string, PlayerActionName[]>();
  for (const action of PLAYER_ACTIONS) {
    for (const code of bindings[action]) {
      const owners = codes.get(code) ?? [];
      owners.push(action);
      codes.set(code, owners);
    }
  }
  return new Map(
    [...codes].filter(([, owners]) => owners.length > 1).map(
      ([code, owners]) => [code, Object.freeze([...owners])] as const
    )
  );
}

export function normalizePlayerHandling(
  value: unknown
): PlayerHandlingConfig | null {
  const source = record(value);
  if (source === null) return null;
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
  } = source;
  if (
    !rangedInteger(arrFrameTenths, HANDLING_RANGES.arrFrameTenths) ||
    !rangedInteger(dasFrameTenths, HANDLING_RANGES.dasFrameTenths) ||
    !rangedInteger(dcdFrameTenths, HANDLING_RANGES.dcdFrameTenths) ||
    !(sdf === "sonic" || rangedInteger(sdf, HANDLING_RANGES.sdf)) ||
    ![dasCancellation, safeLock, preferSoftDrop, irs, ihs]
      .every((flag) => typeof flag === "boolean")
  ) {
    return null;
  }
  return Object.freeze({
    arrFrameTenths,
    dasFrameTenths,
    dcdFrameTenths,
    sdf,
    dasCancellation: dasCancellation as boolean,
    safeLock: safeLock as boolean,
    preferSoftDrop: preferSoftDrop as boolean,
    irs: irs as boolean,
    ihs: ihs as boolean
  });
}

export function normalizePlayerConfig(value: unknown): PlayerConfig | null {
  const source = record(value);
  if (source?.version !== PLAYER_CONFIG_VERSION) return null;
  const bindings = normalizePlayerKeyBindings(source.bindings);
  const handling = normalizePlayerHandling(source.handling);
  return bindings === null || handling === null
    ? null
    : Object.freeze({ version: PLAYER_CONFIG_VERSION, bindings, handling });
}

