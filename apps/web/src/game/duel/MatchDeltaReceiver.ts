import type {
  MatchClientMessage,
  MatchServerMessage
} from "@tetr-d/protocol";

import {
  reduceMatchDelta,
  type MatchDelta,
  type MatchSnapshot
} from "./matchDeltaReducer.ts";

export interface ReceivedMatchState {
  readonly snapshot: MatchSnapshot | null;
  readonly resyncRequest: Extract<
    MatchClientMessage,
    { readonly type: "match.resyncRequest" }
  > | null;
}

const IGNORED: ReceivedMatchState = Object.freeze({
  snapshot: null,
  resyncRequest: null
});

export class MatchDeltaReceiver {
  #matchId: string | null = null;
  #snapshot: MatchSnapshot | null = null;
  #resyncRequested = false;

  start(matchId: string): void {
    this.#matchId = matchId;
    this.#snapshot = null;
    this.#resyncRequested = false;
  }

  acceptSnapshot(message: MatchSnapshot): MatchSnapshot | null {
    if (message.matchId !== this.#matchId) return null;
    if (this.#snapshot !== null) {
      if (message.stateSequence < this.#snapshot.stateSequence) return null;
      if (
        message.stateSequence === this.#snapshot.stateSequence &&
        !this.#resyncRequested
      ) return null;
    }
    this.#snapshot = message;
    this.#resyncRequested = false;
    return message;
  }

  acceptDelta(message: MatchDelta): ReceivedMatchState {
    if (message.matchId !== this.#matchId) return IGNORED;
    const reduced = reduceMatchDelta(this.#snapshot, message);
    if (reduced.status === "stale") return IGNORED;
    if (reduced.status === "accepted") {
      this.#snapshot = reduced.snapshot;
      this.#resyncRequested = false;
      return Object.freeze({
        snapshot: reduced.snapshot,
        resyncRequest: null
      });
    }
    if (this.#resyncRequested) return IGNORED;
    this.#resyncRequested = true;
    return Object.freeze({
      snapshot: null,
      resyncRequest: {
        type: "match.resyncRequest" as const,
        matchId: message.matchId,
        lastStateSequence: this.#snapshot?.stateSequence ?? 0,
        lastEventSequence: this.#snapshot?.lastEventSequence ?? 0
      }
    });
  }
}
