import type {
  PlayerHandlingConfig
} from "../config/v3/index.ts";

export type HandlingPresetId = "official" | "fast" | "controlled" | "custom";

type PresetCoreKey =
  | "arrFrameTenths"
  | "dasFrameTenths"
  | "dcdFrameTenths"
  | "sdf";
type PresetFlagKey =
  | "dasCancellation"
  | "safeLock"
  | "preferSoftDrop";
type PresetKey = PresetCoreKey | PresetFlagKey;

export interface HandlingPreset {
  readonly id: Exclude<HandlingPresetId, "custom">;
  readonly label: string;
  readonly values:
    Pick<PlayerHandlingConfig, PresetCoreKey> &
    Partial<Pick<PlayerHandlingConfig, PresetFlagKey>>;
}

export const HANDLING_PRESETS: readonly HandlingPreset[] = [
  {
    id: "official",
    label: "官网默认",
    values: {
      arrFrameTenths: 20,
      dasFrameTenths: 100,
      dcdFrameTenths: 0,
      sdf: 6
    }
  },
  {
    id: "fast",
    label: "极速参考",
    values: {
      arrFrameTenths: 0,
      dasFrameTenths: 65,
      dcdFrameTenths: 0,
      sdf: "sonic"
    }
  },
  {
    id: "controlled",
    label: "稳健高速",
    values: {
      arrFrameTenths: 13,
      dasFrameTenths: 60,
      dcdFrameTenths: 105,
      sdf: "sonic",
      dasCancellation: false,
      safeLock: true,
      preferSoftDrop: true
    }
  }
];

export function activeHandlingPreset(
  handling: PlayerHandlingConfig
): HandlingPresetId {
  const found = HANDLING_PRESETS.find(({ values }) =>
    (Object.keys(values) as PresetKey[])
      .every((key) => values[key] === handling[key])
  );
  return found?.id ?? "custom";
}
