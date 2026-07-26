import {
  PLAYER_ACTIONS,
  type PlayerActionName,
  type PlayerKeyBindings
} from "../config/playerConfigTypes.ts";

const LABELS: Readonly<Record<string, string>> = Object.freeze({
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Space: "空格",
  Enter: "Enter",
  Escape: "Esc",
  Backspace: "退格",
  ShiftLeft: "左 Shift",
  ShiftRight: "右 Shift",
  ControlLeft: "左 Ctrl",
  ControlRight: "右 Ctrl",
  AltLeft: "左 Alt",
  AltRight: "右 Alt",
  MetaLeft: "左 Meta",
  MetaRight: "右 Meta"
});

export function displayKeyCode(code: string): string {
  const label = LABELS[code];
  if (label !== undefined) return label;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `数字键盘 ${code.slice(6)}`;
  return code;
}

/** Conflicting codes intentionally map to every action in stable UI order. */
export function indexPlayerBindings(
  bindings: PlayerKeyBindings
): ReadonlyMap<string, readonly PlayerActionName[]> {
  const index = new Map<string, PlayerActionName[]>();
  for (const action of PLAYER_ACTIONS) {
    for (const code of bindings[action]) {
      const actions = index.get(code) ?? [];
      actions.push(action);
      index.set(code, actions);
    }
  }
  return new Map(
    [...index].map(([code, actions]) =>
      [code, Object.freeze([...actions])] as const
    )
  );
}

