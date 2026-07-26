import type {
  PendingGarbagePacket
} from "../../../../../packages/protocol/src/matchMessages.ts";

/**
 * READY packets stay red until lock/cancellation, so another animation frame
 * cannot change their visual state. Only a future deadline needs a UI clock.
 */
export function shouldAnimateGarbagePreview(
  packets: readonly PendingGarbagePacket[],
  serverFrame: number
): boolean {
  return packets.some(
    (packet) =>
      packet.amount > 0 &&
      packet.appliesAtFrame > serverFrame
  );
}
