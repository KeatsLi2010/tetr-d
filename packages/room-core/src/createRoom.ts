import { DEFAULT_ROOM_POLICY } from "./model.ts";
import type {
  CreateRoomInput,
  RoomPolicy,
  RoomState
} from "./model.ts";
import { assertRoomInvariants } from "./invariants.ts";
import {
  ROOM_CODE,
  SAFE_ID,
  isSafeTime,
  isTargetWins,
  isValidPlayer,
  isValidPolicy
} from "./validation.ts";

export function createRoom(
  input: CreateRoomInput,
  policy: RoomPolicy = DEFAULT_ROOM_POLICY
): RoomState {
  if (
    !SAFE_ID.test(input.roomId) ||
    !ROOM_CODE.test(input.roomCode) ||
    !isValidPlayer(input.creator) ||
    !SAFE_ID.test(input.connectionId) ||
    !isSafeTime(input.nowMs) ||
    !isValidPolicy(policy)
  ) {
    throw new TypeError("Invalid room creation input.");
  }
  const targetWins = input.settings?.targetWins ?? 3;
  const allowSpectators = input.settings?.allowSpectators ?? false;
  if (!isTargetWins(targetWins) || typeof allowSpectators !== "boolean") {
    throw new TypeError("Invalid room settings.");
  }
  const absoluteExpiresAtMs = input.nowMs + policy.absoluteTtlMs;
  const state: RoomState = {
    roomId: input.roomId,
    roomCode: input.roomCode,
    revision: 1,
    presenceSequence: 1,
    phase: "lobby",
    members: {
      [input.creator.playerId]: {
        player: input.creator,
        joinedOrdinal: 1,
        connection: {
          kind: "connected",
          connectionId: input.connectionId,
          epoch: 0
        }
      }
    },
    seats: [input.creator.playerId, null],
    hostPlayerId: input.creator.playerId,
    ready: [false, false],
    rematchVotes: [false, false],
    settings: { targetWins, allowSpectators },
    rulesStatus: "draft",
    countdown: null,
    series: null,
    activeMatch: null,
    deniedPlayerIds: [],
    nextJoinedOrdinal: 2,
    nextCountdownNumber: 1,
    nextSeriesNumber: 1,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    expiresAtMs: Math.min(
      absoluteExpiresAtMs,
      input.nowMs + policy.lobbyIdleTtlMs
    ),
    absoluteExpiresAtMs,
    closedReason: null
  };
  assertRoomInvariants(state);
  return state;
}
