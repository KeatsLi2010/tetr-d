import type {
  InputAction
} from "../../../../packages/protocol/src/matchMessages.ts";
import type {
  ExpandedPlayerAction
} from "./public.ts";

export function toMatchInputAction(
  action: ExpandedPlayerAction
): InputAction | null {
  if (action.kind === "shift") {
    return action.mode === "wall"
      ? { kind: "moveToWall", direction: action.direction }
      : { kind: "moveStep", direction: action.direction };
  }
  if (action.kind === "softDrop") {
    return action.mode === "floor"
      ? { kind: "sonicDrop" }
      : { kind: "softDropStep", cells: action.cells };
  }
  if (
    action.kind === "hardDrop" ||
    action.kind === "hold" ||
    action.kind === "rotate"
  ) {
    return action;
  }
  return null;
}

export function toMatchInputActions(
  actions: readonly ExpandedPlayerAction[]
): readonly InputAction[] {
  return Object.freeze(
    actions.flatMap((action) => {
      const mapped = toMatchInputAction(action);
      return mapped === null ? [] : [mapped];
    })
  );
}
