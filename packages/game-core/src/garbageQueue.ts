import { insertGarbage, type Board } from "./board.ts";

export interface SimulationGarbagePacket {
  readonly packetId: string;
  readonly sourcePlayerId: string;
  readonly amount: number;
  readonly appliesAtFrame: number;
  readonly hole: number;
}

export interface GarbageCancellationResult {
  readonly packets: readonly SimulationGarbagePacket[];
  readonly cancelled: number;
  readonly attackSpent: number;
  readonly outgoing: number;
}

function validatePacket(packet: SimulationGarbagePacket): void {
  if (
    packet.packetId.length === 0 ||
    packet.sourcePlayerId.length === 0 ||
    !Number.isSafeInteger(packet.amount) ||
    packet.amount < 1 ||
    !Number.isSafeInteger(packet.appliesAtFrame) ||
    packet.appliesAtFrame < 0 ||
    !Number.isSafeInteger(packet.hole) ||
    packet.hole < 0 ||
    packet.hole >= 10
  ) {
    throw new RangeError("Invalid simulation garbage packet.");
  }
}

export function pendingGarbageAmount(
  packets: readonly SimulationGarbagePacket[]
): number {
  return packets.reduce((total, packet) => {
    validatePacket(packet);
    return total + packet.amount;
  }, 0);
}

/** FIFO cancellation. A 2x opener multiplier only increases defense. */
export function cancelGarbageWithAttack(
  packets: readonly SimulationGarbagePacket[],
  attack: number,
  cancellationMultiplier: 1 | 2
): GarbageCancellationResult {
  if (!Number.isSafeInteger(attack) || attack < 0) {
    throw new RangeError("Invalid attack amount.");
  }
  const next = packets.map((packet) => {
    validatePacket(packet);
    return { ...packet };
  });
  let cancellationCapacity = attack * cancellationMultiplier;
  let cancelled = 0;
  while (next.length > 0 && cancellationCapacity > 0) {
    const first = next[0]!;
    const amount = Math.min(first.amount, cancellationCapacity);
    cancelled += amount;
    cancellationCapacity -= amount;
    if (amount === first.amount) next.shift();
    else next[0] = { ...first, amount: first.amount - amount };
  }
  const attackSpent = Math.min(attack, Math.ceil(cancelled / cancellationMultiplier));
  return Object.freeze({
    packets: Object.freeze(next.map((packet) => Object.freeze(packet))),
    cancelled,
    attackSpent,
    outgoing: attack - attackSpent
  });
}

export function applyReadyGarbage(
  board: Board,
  packets: readonly SimulationGarbagePacket[],
  serverFrame: number,
  cap: number
): {
  readonly board: Board;
  readonly packets: readonly SimulationGarbagePacket[];
  readonly appliedHoles: readonly number[];
  readonly overflowed: boolean;
} {
  if (
    !Number.isSafeInteger(serverFrame) || serverFrame < 0 ||
    !Number.isSafeInteger(cap) || cap < 1
  ) {
    throw new RangeError("Invalid garbage application boundary.");
  }
  const next = packets.map((packet) => {
    validatePacket(packet);
    return { ...packet };
  });
  const holes: number[] = [];
  while (next.length > 0 && holes.length < cap) {
    const first = next[0]!;
    if (first.appliesAtFrame > serverFrame) break;
    const amount = Math.min(first.amount, cap - holes.length);
    holes.push(...Array.from({ length: amount }, () => first.hole));
    if (amount === first.amount) next.shift();
    else next[0] = { ...first, amount: first.amount - amount };
  }
  const inserted = insertGarbage(board, holes);
  return Object.freeze({
    board: inserted.board,
    packets: Object.freeze(next.map((packet) => Object.freeze(packet))),
    appliedHoles: Object.freeze(holes),
    overflowed: inserted.overflowed
  });
}
