import type { PieceKind } from "@tetr-d/game-core";

export interface PieceColor {
  readonly fill: string;
  readonly edge: string;
  readonly shine: string;
  readonly glow: string;
}

export const PIECE_COLORS: Readonly<Record<PieceKind, PieceColor>> = {
  I: {
    fill: "#53dff5",
    edge: "#aaf5ff",
    shine: "#d8fbff",
    glow: "rgba(83, 223, 245, 0.38)"
  },
  J: {
    fill: "#6288f5",
    edge: "#a9beff",
    shine: "#dce5ff",
    glow: "rgba(98, 136, 245, 0.38)"
  },
  L: {
    fill: "#f7a451",
    edge: "#ffd09b",
    shine: "#ffe9ca",
    glow: "rgba(247, 164, 81, 0.38)"
  },
  O: {
    fill: "#efd65c",
    edge: "#fff19c",
    shine: "#fff9cf",
    glow: "rgba(239, 214, 92, 0.38)"
  },
  S: {
    fill: "#6fd277",
    edge: "#aff2b4",
    shine: "#dbffde",
    glow: "rgba(111, 210, 119, 0.38)"
  },
  T: {
    fill: "#aa79ee",
    edge: "#d7b5ff",
    shine: "#eee0ff",
    glow: "rgba(170, 121, 238, 0.38)"
  },
  Z: {
    fill: "#ef6879",
    edge: "#ffabb5",
    shine: "#ffdde1",
    glow: "rgba(239, 104, 121, 0.38)"
  }
};

export const LOCKED_COLOR = {
  fill: "#7d879c",
  edge: "#b5bfd1",
  shine: "#d7dfec"
} as const;

export const GARBAGE_COLOR = {
  fill: "#4c5362",
  edge: "#767f91",
  stripe: "rgba(221, 228, 241, 0.13)"
} as const;
