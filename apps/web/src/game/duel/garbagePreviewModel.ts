import type {
  PendingGarbagePacket
} from "../../../../../packages/protocol/src/matchMessages.ts";

export const GARBAGE_PREVIEW_ROWS = 20;
export const SERVER_FRAME_EXTRAPOLATION_MS = 100;

export interface ServerFrameAnchor {
  readonly serverFrame: number;
  readonly receivedAtMs: number;
}

export interface GarbagePreviewSegment {
  readonly packetId: string;
  readonly amount: number;
  readonly bottomPercent: number;
  readonly heightPercent: number;
  readonly remainingFrames: number;
  readonly urgency: number;
  readonly hue: number;
  readonly color: string;
  readonly ready: boolean;
}

export interface GarbagePreviewModel {
  readonly totalAmount: number;
  readonly visibleAmount: number;
  readonly hiddenAmount: number;
  readonly readyAmount: number;
  readonly nextRemainingFrames: number | null;
  readonly segments: readonly GarbagePreviewSegment[];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function estimateServerFrame(
  anchor: ServerFrameAnchor,
  nowMs: number,
  simulationHz: number
): number {
  if (
    !Number.isFinite(anchor.serverFrame) ||
    !Number.isFinite(anchor.receivedAtMs) ||
    !Number.isFinite(nowMs) ||
    !Number.isSafeInteger(simulationHz) ||
    simulationHz < 1
  ) {
    throw new RangeError("Invalid server-frame anchor.");
  }
  const elapsedMs = clamp(
    nowMs - anchor.receivedAtMs,
    0,
    SERVER_FRAME_EXTRAPOLATION_MS
  );
  return anchor.serverFrame + (elapsedMs * simulationHz) / 1_000;
}

export function garbageUrgency(
  appliesAtFrame: number,
  estimatedServerFrame: number,
  travelFrames: number
): {
  readonly remainingFrames: number;
  readonly urgency: number;
  readonly hue: number;
  readonly color: string;
  readonly ready: boolean;
} {
  const remainingFrames = Math.max(
    0,
    appliesAtFrame - estimatedServerFrame
  );
  const urgency = travelFrames <= 0
    ? 1
    : clamp(1 - remainingFrames / travelFrames, 0, 1);
  const hue = 120 * (1 - urgency);
  return {
    remainingFrames,
    urgency,
    hue,
    color: `hsl(${hue.toFixed(1)} 88% 56%)`,
    ready: remainingFrames === 0
  };
}

export function buildGarbagePreviewModel(
  packets: readonly PendingGarbagePacket[],
  estimatedServerFrame: number,
  travelFrames: number,
  capacity = GARBAGE_PREVIEW_ROWS
): GarbagePreviewModel {
  if (
    !Number.isFinite(estimatedServerFrame) ||
    !Number.isSafeInteger(travelFrames) ||
    travelFrames < 0 ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1
  ) {
    throw new RangeError("Invalid garbage preview input.");
  }

  const totalAmount = packets.reduce(
    (total, packet) => total + Math.max(0, packet.amount),
    0
  );
  const positivePackets = packets.filter((packet) => packet.amount > 0);
  const readyAmount = positivePackets.reduce(
    (total, packet) =>
      total + (
        packet.appliesAtFrame <= estimatedServerFrame ? packet.amount : 0
      ),
    0
  );
  const nextRemainingFrames = positivePackets.length === 0
    ? null
    : Math.min(...positivePackets.map((packet) =>
      Math.max(0, packet.appliesAtFrame - estimatedServerFrame)
    ));
  let visibleAmount = 0;
  const segments: GarbagePreviewSegment[] = [];
  for (const packet of packets) {
    if (visibleAmount >= capacity || packet.amount <= 0) break;
    const amount = Math.min(packet.amount, capacity - visibleAmount);
    const timing = garbageUrgency(
      packet.appliesAtFrame,
      estimatedServerFrame,
      travelFrames
    );
    segments.push({
      packetId: packet.packetId,
      amount,
      bottomPercent: (visibleAmount / capacity) * 100,
      heightPercent: (amount / capacity) * 100,
      ...timing
    });
    visibleAmount += amount;
  }
  return {
    totalAmount,
    visibleAmount,
    hiddenAmount: Math.max(0, totalAmount - visibleAmount),
    nextRemainingFrames,
    readyAmount,
    segments: Object.freeze(segments)
  };
}
