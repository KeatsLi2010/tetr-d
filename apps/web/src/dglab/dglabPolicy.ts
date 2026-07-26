import type { DgLabConfig, DgLabPenaltyEvent } from "./dglabTypes.ts";

export interface DgLabPenaltyCommand {
  readonly points: number;
  readonly strength: number;
  readonly durationMs: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative.`);
  return Math.min(20, Math.max(0, Math.floor(value)));
}

export function eventPoints(event: DgLabPenaltyEvent, config: DgLabConfig): number {
  const amount = positiveInteger(event.amount, "event amount");
  return amount * config.weights[event.kind];
}

export function createPenaltyCommand(
  event: DgLabPenaltyEvent,
  config: DgLabConfig
): DgLabPenaltyCommand | null {
  const points = eventPoints(event, config);
  if (points <= 0) return null;
  return Object.freeze({
    points,
    strength: Math.min(
      config.maxStrength,
      Math.max(0, Math.round(config.baseStrength + points * config.strengthPerPoint))
    ),
    durationMs: Math.min(
      config.maxQueueSeconds * 1_000,
      Math.max(config.baseDurationMs, Math.round(config.baseDurationMs + points * config.durationPerPointMs))
    )
  });
}

export function cancellationPoints(event: DgLabPenaltyEvent, config: DgLabConfig): number {
  if (event.kind !== "attackCancelled") return 0;
  return eventPoints(event, config);
}

