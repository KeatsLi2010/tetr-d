import { DEFAULT_ROOM_POLICY } from "./model.ts";
import type {
  RoomCommand,
  RoomPolicy,
  RoomState,
  RoomTransition
} from "./model.ts";
import { handleMatchCommand } from "./handlers/matchCommands.ts";
import { handlePresenceCommand } from "./handlers/presenceCommands.ts";
import { handleRoomCommand } from "./handlers/roomCommands.ts";
import {
  closeState,
  commit,
  reject
} from "./operations.ts";
import {
  isSafeTime,
  isValidPolicy
} from "./validation.ts";

export { createRoom } from "./createRoom.ts";
export { assertRoomInvariants } from "./invariants.ts";

export function transitionRoom(
  state: RoomState,
  command: RoomCommand,
  policy: RoomPolicy = DEFAULT_ROOM_POLICY
): RoomTransition {
  if (!isSafeTime(command.atMs) || !isValidPolicy(policy)) {
    return reject(state, "INVALID_COMMAND");
  }
  if (state.phase === "closed" && "requestId" in command) {
    return reject(state, "ROOM_CLOSED");
  }
  if (
    state.phase !== "closed" &&
    state.phase !== "playing" &&
    command.type !== "timer.room_expired" &&
    command.type !== "admin.close" &&
    command.atMs >= state.expiresAtMs
  ) {
    return commit(
      state,
      closeState(state, "expired"),
      command.atMs,
      [{ type: "room.closed", reason: "expired" }],
      policy
    );
  }

  return (
    handleRoomCommand(state, command, policy) ??
    handlePresenceCommand(state, command, policy) ??
    handleMatchCommand(state, command, policy) ??
    reject(state, "INVALID_COMMAND")
  );
}

export const reduceRoom = transitionRoom;
