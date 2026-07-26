import type {
  PlayerConfig,
  PlayerKeyBindings
} from "../config/v3/index.ts";

export type BindingPreset = "guideline" | "wasd" | "custom";

export const GUIDELINE_BINDINGS: PlayerKeyBindings = Object.freeze({
  moveLeft: Object.freeze(["ArrowLeft", "Numpad4"]),
  moveRight: Object.freeze(["ArrowRight", "Numpad6"]),
  softDrop: Object.freeze(["ArrowDown", "Numpad2"]),
  hardDrop: Object.freeze(["Space", "Numpad8"]),
  rotateCW: Object.freeze(["ArrowUp", "KeyX", "Numpad1"]),
  rotateCCW: Object.freeze(["ControlLeft", "KeyZ", "Numpad3"]),
  rotate180: Object.freeze(["KeyA"]),
  hold: Object.freeze(["ShiftLeft", "KeyC", "Numpad0"]),
  forfeit: Object.freeze(["Escape"]),
  retry: Object.freeze(["KeyR"]),
  openChat: Object.freeze(["KeyT"])
});

export const WASD_BINDINGS: PlayerKeyBindings = Object.freeze({
  moveLeft: Object.freeze(["KeyA", "Numpad4"]),
  moveRight: Object.freeze(["KeyD", "Numpad6"]),
  softDrop: Object.freeze(["KeyW", "Numpad8"]),
  hardDrop: Object.freeze(["KeyS", "Numpad5"]),
  rotateCW: Object.freeze(["ArrowRight", "Numpad9"]),
  rotateCCW: Object.freeze(["ArrowLeft", "Numpad7"]),
  rotate180: Object.freeze(["ArrowUp", "Numpad2"]),
  hold: Object.freeze(["ShiftLeft", "NumpadEnter"]),
  forfeit: Object.freeze(["Escape"]),
  retry: Object.freeze(["KeyR"]),
  openChat: Object.freeze(["KeyT"])
});

function sameBindings(
  left: PlayerKeyBindings,
  right: PlayerKeyBindings
): boolean {
  return Object.keys(left).every((action) => {
    const key = action as keyof PlayerKeyBindings;
    return left[key].length === right[key].length &&
      left[key].every((code, index) => right[key][index] === code);
  });
}

export function activeBindingPreset(
  config: PlayerConfig
): BindingPreset {
  if (sameBindings(config.bindings, GUIDELINE_BINDINGS)) return "guideline";
  if (sameBindings(config.bindings, WASD_BINDINGS)) return "wasd";
  return "custom";
}
