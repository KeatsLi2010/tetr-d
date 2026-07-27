import type { DgLabWaveformFrame, DgLabWaveformId } from "./dglabTypes.ts";
export type { DgLabWaveformFrame } from "./dglabTypes.ts";

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

export function waveformFrames(
  id: DgLabWaveformId,
  custom: readonly DgLabWaveformFrame[] = []
): readonly DgLabWaveformFrame[] {
  if (id === "custom" && custom.length >= 4) return custom;
  return id === "tide" ? TIDE : BREATH;
}

export function waveformHex(frameValue: DgLabWaveformFrame): string {
  const frequencies = frameValue.frequencySteps ?? [frameValue.frequency, frameValue.frequency, frameValue.frequency, frameValue.frequency];
  const intensities = frameValue.intensitySteps ?? [frameValue.intensity, frameValue.intensity, frameValue.intensity, frameValue.intensity];
  return [...frequencies, ...intensities].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function waveformPayload(
  id: DgLabWaveformId,
  custom: readonly DgLabWaveformFrame[] = []
): readonly string[] {
  return Object.freeze(waveformFrames(id, custom).map(waveformHex));
}

function parsedFrame(value: unknown): DgLabWaveformFrame | null {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return validFrame(value[0], value[1]);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    if (typeof source.frequency === "number" && typeof source.intensity === "number") return validFrame(source.frequency, source.intensity);
  }
  if (typeof value === "string" && /^[0-9A-Fa-f]{16}$/.test(value)) {
    const bytes = value.match(/[0-9A-Fa-f]{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? [];
    if (bytes.length === 8 && bytes.slice(0, 4).every((item) => item >= 10 && item <= 240) && bytes.slice(4).every((item) => item >= 0 && item <= 100)) {
      return Object.freeze({
        frequency: bytes[0]!,
        intensity: bytes[4]!,
        frequencySteps: Object.freeze(bytes.slice(0, 4)) as [number, number, number, number],
        intensitySteps: Object.freeze(bytes.slice(4)) as [number, number, number, number]
      });
    }
  }
  return null;
}

function validFrame(frequency: number, intensity: number): DgLabWaveformFrame | null {
  if (!Number.isFinite(frequency) || !Number.isFinite(intensity) || frequency < 10 || frequency > 240 || intensity < 0 || intensity > 100) return null;
  return Object.freeze({ frequency: Math.round(frequency), intensity: Math.round(intensity) });
}

export function normalizeCustomWaveform(value: unknown): readonly DgLabWaveformFrame[] | null {
  if (!Array.isArray(value) || value.length < 4 || value.length > 240) return null;
  const frames = value.map(parsedFrame);
  return frames.every((frame): frame is DgLabWaveformFrame => frame !== null) ? Object.freeze(frames) : null;
}

export function parseWaveformText(text: string): readonly DgLabWaveformFrame[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const jsonValue: unknown = JSON.parse(trimmed);
    const jsonFrames = typeof jsonValue === "object" && jsonValue !== null && !Array.isArray(jsonValue)
      ? (jsonValue as Record<string, unknown>).frames
      : jsonValue;
    const parsed = normalizeCustomWaveform(jsonFrames);
    if (parsed !== null) return parsed;
  } catch { /* fall through to line and HEX formats */ }
  const values = trimmed.split(/[\s;]+/).filter(Boolean).map((line) => {
    const parts = line.split(/[,:，、]+/).map((part) => Number(part.trim()));
    return parts.length === 2 && parts.every(Number.isFinite) ? parts : line;
  });
  return normalizeCustomWaveform(values);
}

export function serializeWaveform(frames: readonly DgLabWaveformFrame[]): string {
  return frames.map((frameValue) => frameValue.frequencySteps === undefined ? `${frameValue.frequency},${frameValue.intensity}` : waveformHex(frameValue)).join("\n");
}
