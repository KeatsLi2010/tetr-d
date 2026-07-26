export interface PlayerSimulationRules {
  readonly tickRateHz: number;
  readonly spawnX: number;
  readonly spawnY: number;
  readonly dasFrames: number;
  readonly arrFrames: number;
  readonly gravityMicrosPerSecond: number;
  readonly softDropMicrosPerSecond: number;
  readonly lockDelayFrames: number;
  readonly lockResetLimit: number;
  readonly garbageTravelFrames: number;
  readonly garbageCap: number;
  readonly nextPreviewCount: number;
}

export interface PlayerSimulationRuleOverrides {
  readonly dasMs?: number;
  readonly arrMs?: number;
  readonly gravityCellsPerSecond?: number;
  readonly softDropCellsPerSecond?: number;
  readonly lockDelayMs?: number;
  readonly lockResetLimit?: number;
  readonly garbageTravel60HzFrames?: number;
  readonly garbageCap?: number;
  readonly nextPreviewCount?: number;
}

const MICROS_PER_CELL = 1_000_000;

function durationFrames(milliseconds: number, tickRateHz: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError("Invalid simulation duration.");
  }
  return Math.ceil((milliseconds * tickRateHz) / 1_000);
}

function rateMicros(cellsPerSecond: number): number {
  const value = Math.round(cellsPerSecond * MICROS_PER_CELL);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Invalid simulation cell rate.");
  }
  return value;
}

export function createPlayerSimulationRules(
  tickRateHz: number,
  overrides: PlayerSimulationRuleOverrides = {}
): PlayerSimulationRules {
  if (!Number.isSafeInteger(tickRateHz) || tickRateHz < 60 || tickRateHz > 1_000) {
    throw new RangeError("Simulation tick rate must be from 60 to 1000 Hz.");
  }
  const lockResetLimit = overrides.lockResetLimit ?? 15;
  const garbageTravel60HzFrames = overrides.garbageTravel60HzFrames ?? 20;
  const garbageCap = overrides.garbageCap ?? 8;
  const nextPreviewCount = overrides.nextPreviewCount ?? 5;
  for (const [name, value] of [
    ["lock reset limit", lockResetLimit],
    ["garbage travel", garbageTravel60HzFrames],
    ["garbage cap", garbageCap],
    ["next preview count", nextPreviewCount]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Invalid ${name}.`);
    }
  }
  if (garbageCap < 1 || nextPreviewCount < 1 || nextPreviewCount > 14) {
    throw new RangeError("Invalid simulation queue limits.");
  }
  return Object.freeze({
    tickRateHz,
    spawnX: 3,
    spawnY: 17,
    dasFrames: durationFrames(overrides.dasMs ?? 100, tickRateHz),
    arrFrames: durationFrames(overrides.arrMs ?? 0, tickRateHz),
    gravityMicrosPerSecond: rateMicros(
      overrides.gravityCellsPerSecond ?? 1.2
    ),
    softDropMicrosPerSecond: rateMicros(
      overrides.softDropCellsPerSecond ?? 1_200
    ),
    lockDelayFrames: durationFrames(
      overrides.lockDelayMs ?? 500,
      tickRateHz
    ),
    lockResetLimit,
    garbageTravelFrames: Math.ceil(
      (garbageTravel60HzFrames * tickRateHz) / 60
    ),
    garbageCap,
    nextPreviewCount
  });
}

export const SIMULATION_MICROS_PER_CELL = MICROS_PER_CELL;
