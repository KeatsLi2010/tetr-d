import type { MatchEvent } from "@tetr-d/protocol";

import { duelStatePenaltyEvents } from "../../dglab/dglabEvents.ts";
import type { DgLabPenaltyEvent } from "../../dglab/dglabTypes.ts";
import type { NetworkPlayerState } from "./networkPlayerState.ts";

function pendingAmount(player: NetworkPlayerState): number {
  return player.pendingGarbage.reduce((sum, packet) => sum + packet.amount, 0);
}

export class DuelPenaltyDetector {
  #previous: { backToBack: number; combo: number; pending: number; packets: ReadonlyMap<string, number> } | null = null;

  reset(): void { this.#previous = null; }

  observe(
    players: readonly NetworkPlayerState[],
    playerId: string | null,
    events: readonly MatchEvent[],
    emit: (event: DgLabPenaltyEvent) => void
  ): void {
    const own = playerId === null ? undefined : players.find((player) => player.playerId === playerId);
    if (own === undefined) return;
    const received = events.reduce((sum, event) => event.kind === "garbage.queued" && event.targetPlayerId === own.playerId ? sum + event.packet.amount : sum, 0);
    const applied = events.reduce((sum, event) => {
      if (event.kind !== "garbage.applied" || event.targetPlayerId !== own.playerId || this.#previous === null) return sum;
      return sum + (this.#previous.packets.get(event.packetId) ?? 0);
    }, 0);
    const next = {
      backToBack: own.backToBack,
      combo: own.combo,
      pending: pendingAmount(own),
      packets: new Map(own.pendingGarbage.map((packet) => [packet.packetId, packet.amount]))
    };
    const cancelled = this.#previous === null ? 0 : Math.max(0, this.#previous.pending + received - next.pending - applied);
    for (const event of duelStatePenaltyEvents(this.#previous, next, received, cancelled)) emit(event);
    this.#previous = next;
  }
}
