export function clientFrameAt(
  nowMs: number,
  matchStartedAtMs: number,
  simulationHz: number
): number {
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(matchStartedAtMs) ||
    !Number.isSafeInteger(simulationHz) ||
    simulationHz < 1
  ) {
    throw new RangeError("Invalid client-frame clock input.");
  }
  return Math.max(
    0,
    Math.floor(((nowMs - matchStartedAtMs) * simulationHz) / 1_000)
  );
}
