import { TARGET_WINS_OPTIONS } from "./model.ts";
import type {
  PublicRoomPlayer,
  RoomMember,
  RoomPolicy,
  RoomState,
  SeatIndex,
  TargetWins
} from "./model.ts";

export const SAFE_ID = /^(?!(?:__proto__|prototype|constructor)$)[A-Za-z0-9_.:-]{1,128}$/;
export const ROOM_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
export const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function ownMember(
  members: Readonly<Record<string, RoomMember>>,
  playerId: string
): RoomMember | undefined {
  return hasOwn(members, playerId) ? members[playerId] : undefined;
}

export function isSafeTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isTargetWins(value: unknown): value is TargetWins {
  return (
    typeof value === "number" &&
    TARGET_WINS_OPTIONS.includes(value as TargetWins)
  );
}

export function isValidPlayer(player: PublicRoomPlayer): boolean {
  const nameLength = [...player.displayName].length;
  return (
    SAFE_ID.test(player.playerId) &&
    nameLength >= 1 &&
    nameLength <= 24 &&
    player.displayName.trim() === player.displayName &&
    !CONTROL_CHARACTER.test(player.displayName)
  );
}

export function isValidPolicy(policy: RoomPolicy): boolean {
  return (
    Number.isSafeInteger(policy.countdownMs) &&
    policy.countdownMs > 0 &&
    Number.isSafeInteger(policy.maxSpectators) &&
    policy.maxSpectators >= 0 &&
    Number.isSafeInteger(policy.matchReconnectGraceMs) &&
    policy.matchReconnectGraceMs > 0 &&
    Number.isSafeInteger(policy.lobbyReconnectGraceMs) &&
    policy.lobbyReconnectGraceMs > 0 &&
    Number.isSafeInteger(policy.emptyTtlMs) &&
    policy.emptyTtlMs > 0 &&
    Number.isSafeInteger(policy.lobbyIdleTtlMs) &&
    policy.lobbyIdleTtlMs > 0 &&
    Number.isSafeInteger(policy.seriesCompleteTtlMs) &&
    policy.seriesCompleteTtlMs > 0 &&
    Number.isSafeInteger(policy.absoluteTtlMs) &&
    policy.absoluteTtlMs > 0
  );
}

export function connected(member: RoomMember | undefined): boolean {
  return member?.connection.kind === "connected";
}

export function seatOf(state: RoomState, playerId: string): SeatIndex | null {
  if (state.seats[0] === playerId) return 0;
  if (state.seats[1] === playerId) return 1;
  return null;
}

export function rosterOf(
  state: RoomState
): readonly [string, string] | null {
  const [left, right] = state.seats;
  return left !== null && right !== null ? [left, right] : null;
}

export function spectatorCount(state: RoomState): number {
  const seated = new Set(state.seats.filter((value) => value !== null));
  return Object.keys(state.members).filter((id) => !seated.has(id)).length;
}

export function setMember(
  members: Readonly<Record<string, RoomMember>>,
  playerId: string,
  member: RoomMember
): Readonly<Record<string, RoomMember>> {
  return { ...members, [playerId]: member };
}

export function withoutMember(
  members: Readonly<Record<string, RoomMember>>,
  playerId: string
): Readonly<Record<string, RoomMember>> {
  const next = { ...members };
  delete next[playerId];
  return next;
}

export function chooseHost(state: RoomState): string | null {
  const candidates = Object.values(state.members).filter(connected);
  candidates.sort((left, right) => {
    const leftSeat = seatOf(state, left.player.playerId) !== null;
    const rightSeat = seatOf(state, right.player.playerId) !== null;
    const leftConnected = connected(left);
    const rightConnected = connected(right);
    const leftGroup = leftConnected ? (leftSeat ? 0 : 1) : leftSeat ? 2 : 3;
    const rightGroup = rightConnected ? (rightSeat ? 0 : 1) : rightSeat ? 2 : 3;
    return leftGroup - rightGroup || left.joinedOrdinal - right.joinedOrdinal;
  });
  return candidates[0]?.player.playerId ?? null;
}
