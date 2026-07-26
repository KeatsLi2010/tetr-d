export const DEFAULT_MATCH_TICK_RATE_HZ = 240;
export const MIN_MATCH_TICK_RATE_HZ = 60;
export const MAX_MATCH_TICK_RATE_HZ = 1_000;

export function parseMatchTickRateHz(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_MATCH_TICK_RATE_HZ;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`Invalid MATCH_TICK_RATE_HZ: ${value}`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_MATCH_TICK_RATE_HZ ||
    parsed > MAX_MATCH_TICK_RATE_HZ
  ) {
    throw new Error(
      `MATCH_TICK_RATE_HZ must be an integer from ${MIN_MATCH_TICK_RATE_HZ} to ${MAX_MATCH_TICK_RATE_HZ}.`
    );
  }
  return parsed;
}

/** Converts wall-clock duration to the first frame at or after the deadline. */
export function framesForMilliseconds(
  milliseconds: number,
  tickRateHz: number
): number {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError("Invalid match duration.");
  }
  validateTickRate(tickRateHz);
  return Math.ceil((milliseconds * tickRateHz) / 1_000);
}

/** Preserves the duration of a rule originally expressed in 60 Hz frames. */
export function scale60HzFrames(
  framesAt60Hz: number,
  tickRateHz: number
): number {
  if (!Number.isSafeInteger(framesAt60Hz) || framesAt60Hz < 0) {
    throw new RangeError("Invalid 60 Hz frame duration.");
  }
  validateTickRate(tickRateHz);
  return Math.ceil((framesAt60Hz * tickRateHz) / 60);
}

function validateTickRate(tickRateHz: number): void {
  if (
    !Number.isSafeInteger(tickRateHz) ||
    tickRateHz < MIN_MATCH_TICK_RATE_HZ ||
    tickRateHz > MAX_MATCH_TICK_RATE_HZ
  ) {
    throw new RangeError("Invalid match tick rate.");
  }
}
