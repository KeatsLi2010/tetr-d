import type { MatchServerMessage } from "../../../../packages/protocol/src/matchMessages.ts";

type Snapshot = Extract<
  MatchServerMessage,
  { readonly type: "match.snapshot" }
>;

interface ViewerBaseline {
  readonly connectionGeneration: number;
  readonly snapshot: Snapshot;
}

export class MatchDeliveryBaselines {
  readonly #matches = new Map<string, Map<string, ViewerBaseline>>();

  get(
    matchId: string,
    playerId: string,
    connectionGeneration: number
  ): Snapshot | null {
    const viewers = this.#matches.get(matchId);
    const baseline = viewers?.get(playerId);
    if (baseline === undefined) return null;
    if (baseline.connectionGeneration === connectionGeneration) {
      return baseline.snapshot;
    }
    viewers!.delete(playerId);
    if (viewers!.size === 0) this.#matches.delete(matchId);
    return null;
  }

  accept(
    matchId: string,
    playerId: string,
    connectionGeneration: number,
    snapshot: Snapshot
  ): void {
    let viewers = this.#matches.get(matchId);
    if (viewers === undefined) {
      viewers = new Map();
      this.#matches.set(matchId, viewers);
    }
    viewers.set(playerId, Object.freeze({
      connectionGeneration,
      snapshot
    }));
  }

  reject(matchId: string, playerId: string): void {
    const viewers = this.#matches.get(matchId);
    if (viewers === undefined) return;
    viewers.delete(playerId);
    if (viewers.size === 0) this.#matches.delete(matchId);
  }

  clearMatch(matchId: string): void {
    this.#matches.delete(matchId);
  }

  clear(): void {
    this.#matches.clear();
  }
}
