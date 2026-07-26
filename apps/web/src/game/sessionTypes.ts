import type {
  PlayerSimulationView,
  SimulationInputAction
} from "@tetr-d/game-core";

export type GameSessionPhase = "idle" | "playing" | "paused" | "ended";

export interface GameSessionStats {
  readonly elapsedMs: number;
  readonly lines: number;
  readonly pieces: number;
  readonly attack: number;
  readonly pps: number;
  readonly apm: number;
}

export interface GameSessionSnapshot {
  readonly phase: GameSessionPhase;
  readonly tickRateHz: number;
  readonly frame: number;
  readonly player: PlayerSimulationView;
  readonly stats: GameSessionStats;
}

export type GameSessionListener = (snapshot: GameSessionSnapshot) => void;

/**
 * UI-facing contract shared by local practice now and a room-backed session
 * later. Input is queued for a simulation tick; dispatch never advances time.
 */
export interface GameSession {
  readonly snapshot: GameSessionSnapshot;
  start(): GameSessionSnapshot;
  pause(): GameSessionSnapshot;
  resume(): GameSessionSnapshot;
  restart(): GameSessionSnapshot;
  advanceTo(nowMs?: number): GameSessionSnapshot;
  dispatch(action: SimulationInputAction): void;
  subscribe(listener: GameSessionListener): () => void;
  dispose(): void;
}
