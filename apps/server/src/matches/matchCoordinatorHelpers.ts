import type {
  SimulationPieceSource
} from "../../../../packages/game-core/src/index.ts";
import type { PieceKind } from "../../../../packages/game-core/src/types.ts";
import type {
  InputAcknowledgement
} from "../../../../packages/protocol/src/matchMessages.ts";
import type { MatchPieceSequence } from "../matchPieceSequence.ts";
import type { QueuedInputDisposition } from "./matchInputQueue.ts";

export class SequencePieceSource implements SimulationPieceSource {
  readonly sequence: MatchPieceSequence;
  readonly playerId: string;

  constructor(sequence: MatchPieceSequence, playerId: string) {
    this.sequence = sequence;
    this.playerId = playerId;
  }

  draw(): PieceKind {
    const piece = this.sequence.draw(this.playerId).pieces[0];
    if (piece === undefined) throw new Error("Piece sequence returned no piece.");
    return piece;
  }

  peek(count: number): readonly PieceKind[] {
    return this.sequence.peek(this.playerId, count).pieces;
  }

  getCursor(): number { return this.sequence.getCursor(this.playerId); }
}

export function mapDisposition(
  disposition: QueuedInputDisposition
): InputAcknowledgement["dispositions"][number] {
  if (disposition.status !== "rejected") return disposition;
  const reason = disposition.reason === "gap"
    ? "gap"
    : disposition.reason === "late"
      ? "late"
      : disposition.reason === "too_far_future"
        ? "too_far_future"
        : "invalid";
  return { sequence: disposition.sequence, status: "rejected", reason };
}

export function netPacketLists(
  first: readonly number[],
  second: readonly number[]
): readonly [readonly number[], readonly number[]] {
  const left = [...first];
  const right = [...second];
  while (left.length > 0 && right.length > 0) {
    const amount = Math.min(left[0]!, right[0]!);
    left[0] = left[0]! - amount;
    right[0] = right[0]! - amount;
    if (left[0] === 0) left.shift();
    if (right[0] === 0) right.shift();
  }
  return [Object.freeze(left), Object.freeze(right)];
}
