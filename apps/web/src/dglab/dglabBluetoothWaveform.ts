export interface DgLabWaveformState {
  payload: readonly string[];
  index: number;
  timer: ReturnType<typeof setInterval> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

export const INVALID_WAVEFORM = Object.freeze({
  frequencies: [10, 10, 10, 10],
  intensities: [101, 101, 101, 101]
});

export function createWaveformState(): DgLabWaveformState {
  return { payload: [], index: 0, timer: null, stopTimer: null };
}

export function clearWaveformState(state: DgLabWaveformState): void {
  if (state.timer !== null) clearInterval(state.timer);
  if (state.stopTimer !== null) clearTimeout(state.stopTimer);
  state.timer = null;
  state.stopTimer = null;
  state.payload = [];
  state.index = 0;
}

export function parseWaveformPayload(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !/^[0-9A-Fa-f]{16}$/.test(item))) return null;
  return value as string[];
}

export function waveformBytes(state: DgLabWaveformState, advance = true): { readonly frequencies: readonly number[]; readonly intensities: readonly number[] } {
  const active = state.payload[state.index % Math.max(1, state.payload.length)];
  state.index += advance && state.payload.length > 0 ? 1 : 0;
  if (active === undefined || !/^[0-9A-Fa-f]{16}$/.test(active)) return INVALID_WAVEFORM;
  const bytes = Array.from({ length: 8 }, (_, index) => Number.parseInt(active.slice(index * 2, index * 2 + 2), 16));
  return { frequencies: bytes.slice(0, 4), intensities: bytes.slice(4, 8) };
}
