import type { ClientMessage, MatchFeedbackState, PublicPlayer } from "@tetr-d/protocol";

export function initialDuelFeedback(players: readonly PublicPlayer[]): Readonly<Record<string, MatchFeedbackState>> {
  return Object.freeze(Object.fromEntries(players.map((player) => [player.playerId, hiddenDuelFeedback()])));
}

export function mergeDuelFeedback(
  current: Readonly<Record<string, MatchFeedbackState>>,
  playerId: string,
  feedback: MatchFeedbackState
): Readonly<Record<string, MatchFeedbackState>> {
  return Object.freeze({ ...current, [playerId]: feedback });
}

export function hiddenDuelFeedback(): MatchFeedbackState {
  return {
    visible: false,
    connected: false,
    armed: false,
    channelA: { strength: 0, limit: 0 },
    channelB: { strength: 0, limit: 0 }
  };
}

export class DuelFeedbackPublisher {
  readonly #getMatchId: () => string | undefined;
  readonly #send: (message: ClientMessage) => boolean;
  #feedback: MatchFeedbackState = hiddenDuelFeedback();
  #lastSentAt = -Infinity;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    getMatchId: () => string | undefined,
    send: (message: ClientMessage) => boolean
  ) {
    this.#getMatchId = getMatchId;
    this.#send = send;
  }

  update(feedback: MatchFeedbackState): void {
    this.#feedback = feedback;
    this.#schedule();
  }

  start(): void {
    this.#lastSentAt = -Infinity;
    this.#schedule(true);
  }

  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(force = false): void {
    const matchId = this.#getMatchId();
    if (matchId === undefined) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    const wait = force ? 0 : Math.max(0, 100 - (performance.now() - this.#lastSentAt));
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#getMatchId() !== matchId) return;
      this.#send({ type: "match.feedback", matchId, ...this.#feedback });
      this.#lastSentAt = performance.now();
    }, wait);
  }
}
