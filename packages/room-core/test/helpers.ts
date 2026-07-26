import assert from "node:assert/strict";
import {
  DEFAULT_ROOM_POLICY,
  assertRoomInvariants,
  createRoom,
  transitionRoom
} from "../src/index.ts";
import type {
  CreateRoomInput,
  RoomCommand,
  RoomState,
  RoomTransition
} from "../src/index.ts";

export { DEFAULT_ROOM_POLICY };

export const HOST = { playerId: "host", displayName: "Host" } as const;
export const GUEST = { playerId: "guest", displayName: "Guest" } as const;
export const WATCHER = { playerId: "watcher", displayName: "Watcher" } as const;

export function fresh(overrides: Partial<CreateRoomInput> = {}): RoomState {
  return createRoom({
    roomId: "room-1",
    roomCode: "ABC234",
    creator: HOST,
    connectionId: "connection-host",
    nowMs: 1_000,
    ...overrides
  });
}

export function apply(state: RoomState, command: RoomCommand): RoomTransition {
  return transitionRoom(state, command);
}

export function committed(state: RoomState, command: RoomCommand): RoomState {
  const result = apply(state, command);
  assert.equal(result.kind, "committed");
  if (result.kind !== "committed") throw new Error("Expected commit");
  assertRoomInvariants(result.state);
  return result.state;
}

export function joinGuest(state: RoomState, atMs = 1_100): RoomState {
  return committed(state, {
    type: "member.join",
    requestId: "join-guest",
    player: GUEST,
    connectionId: "connection-guest",
    participation: "player",
    atMs
  });
}

export function setReady(
  state: RoomState,
  actorPlayerId: string,
  ready: boolean,
  atMs: number
): RoomState {
  return committed(state, {
    type: "ready.set",
    requestId: `ready-${actorPlayerId}-${atMs}`,
    actorPlayerId,
    expectedRevision: state.revision,
    ready,
    atMs
  });
}

export function startMatch(state: RoomState, atMs = 5_000): RoomState {
  const hostReady = setReady(state, HOST.playerId, true, atMs - 3_100);
  const countdown = setReady(hostReady, GUEST.playerId, true, atMs - 3_000);
  assert.equal(countdown.phase, "countdown");
  assert.ok(countdown.countdown);
  return committed(countdown, {
    type: "timer.countdown_elapsed",
    countdownId: countdown.countdown.countdownId,
    matchId: `match-${atMs}`,
    atMs
  });
}
