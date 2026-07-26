import type { DgLabWaveformId } from "./dglabTypes.ts";

export interface DgLabWaveformFrame {
  readonly frequency: number;
  readonly intensity: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function frame(frequency: number, intensity: number): DgLabWaveformFrame {
  return Object.freeze({
    frequency: clamp(frequency, 10, 100),
    intensity: clamp(intensity, 0, 100)
  });
}

const BREATH: readonly DgLabWaveformFrame[] = Object.freeze([
  frame(12, 0), frame(12, 8), frame(12, 18), frame(12, 30),
  frame(12, 44), frame(12, 58), frame(12, 72), frame(12, 86),
  frame(12, 100), frame(12, 92), frame(12, 78), frame(12, 62),
  frame(12, 44), frame(12, 28), frame(12, 12), frame(12, 0)
]);

const TIDE: readonly DgLabWaveformFrame[] = Object.freeze([
  frame(20, 8), frame(24, 16), frame(28, 24), frame(32, 32),
  frame(38, 42), frame(44, 52), frame(50, 62), frame(56, 72),
  frame(62, 82), frame(68, 92), frame(62, 82), frame(56, 72),
  frame(50, 62), frame(44, 52), frame(38, 42), frame(32, 32),
  frame(28, 24), frame(24, 16), frame(20, 8), frame(20, 0)
]);

export function waveformFrames(id: DgLabWaveformId): readonly DgLabWaveformFrame[] {
  return id === "tide" ? TIDE : BREATH;
}

export function waveformHex(frameValue: DgLabWaveformFrame): string {
  const frequency = frameValue.frequency.toString(16).padStart(2, "0");
  const intensity = frameValue.intensity.toString(16).padStart(2, "0");
  return `${frequency.repeat(4)}${intensity.repeat(4)}`.toUpperCase();
}

export function waveformPayload(id: DgLabWaveformId): readonly string[] {
  return Object.freeze(waveformFrames(id).map(waveformHex));
}

