import type { PlayerActionName } from "../config/playerConfigTypes.ts";

export type ShiftDirection = "left" | "right";
export type RotationDirection = "cw" | "ccw" | "180";

export type ExpandedPlayerAction =
  | {
      readonly kind: "shift";
      readonly direction: ShiftDirection;
      readonly mode: "step" | "wall";
    }
  | {
      readonly kind: "softDrop";
      readonly mode: "cells";
      readonly cells: number;
    }
  | { readonly kind: "softDrop"; readonly mode: "floor" }
  | { readonly kind: "hardDrop" }
  | { readonly kind: "rotate"; readonly direction: RotationDirection }
  | { readonly kind: "hold" }
  | { readonly kind: "forfeit" }
  | { readonly kind: "retry" }
  | { readonly kind: "openChat" };

export const PLAYER_ACTION_LABELS_ZH: Readonly<
  Record<PlayerActionName, string>
> = Object.freeze({
  moveLeft: "左移",
  moveRight: "右移",
  softDrop: "软降",
  hardDrop: "硬降",
  rotateCW: "顺时针旋转",
  rotateCCW: "逆时针旋转",
  rotate180: "180° 旋转",
  hold: "暂存",
  forfeit: "投降",
  retry: "重试",
  openChat: "打开聊天"
});

export function shiftAction(
  direction: ShiftDirection,
  mode: "step" | "wall"
): ExpandedPlayerAction {
  return Object.freeze({ kind: "shift", direction, mode });
}

export function softDropCells(cells: number): ExpandedPlayerAction {
  if (!Number.isSafeInteger(cells) || cells < 1 || cells > 40) {
    throw new RangeError("Soft-drop cells must be an integer from 1 to 40.");
  }
  return Object.freeze({ kind: "softDrop", mode: "cells", cells });
}

export const SOFT_DROP_TO_FLOOR: ExpandedPlayerAction =
  Object.freeze({ kind: "softDrop", mode: "floor" });
export const HARD_DROP: ExpandedPlayerAction =
  Object.freeze({ kind: "hardDrop" });
export const HOLD: ExpandedPlayerAction = Object.freeze({ kind: "hold" });
export const FORFEIT: ExpandedPlayerAction =
  Object.freeze({ kind: "forfeit" });
export const RETRY: ExpandedPlayerAction = Object.freeze({ kind: "retry" });
export const OPEN_CHAT: ExpandedPlayerAction =
  Object.freeze({ kind: "openChat" });

export function rotateAction(
  direction: RotationDirection
): ExpandedPlayerAction {
  return Object.freeze({ kind: "rotate", direction });
}

