import type {
  MatchClientMessage,
  MatchFeedbackState,
  MatchServerMessage
} from "../../../../packages/protocol/src/matchMessages.ts";

type FeedbackMessage = Extract<MatchClientMessage, { readonly type: "match.feedback" }>;
function hiddenFeedback(): MatchFeedbackState {
  return {
    visible: false,
    connected: false,
    armed: false,
    channelA: { strength: 0, limit: 0 },
    channelB: { strength: 0, limit: 0 }
  };
}

function normalizeFeedback(message: FeedbackMessage): MatchFeedbackState {
  if (!message.visible || !message.connected) return hiddenFeedback();
  return {
    visible: true,
    connected: true,
    armed: message.armed,
    channelA: {
      strength: message.armed ? message.channelA.strength : 0,
      limit: message.channelA.limit
    },
    channelB: {
      strength: message.armed ? message.channelB.strength : 0,
      limit: message.channelB.limit
    }
  };
}

export class MatchFeedbackRegistry {
  readonly #states = new Map<string, Map<string, MatchFeedbackState>>();

  start(matchId: string): void { this.#states.set(matchId, new Map()); }

  delete(matchId: string): void { this.#states.delete(matchId); }

  clearAll(): void { this.#states.clear(); }

  snapshots(
    matchId: string,
    participants: readonly string[]
  ): readonly MatchServerMessage[] {
    const states = this.#states.get(matchId);
    return participants.map((playerId) => ({
      type: "match.feedback",
      matchId,
      playerId,
      feedback: states?.get(playerId) ?? hiddenFeedback()
    }));
  }

  receive(
    playerId: string,
    message: FeedbackMessage,
    participants: readonly string[]
  ): MatchFeedbackState | null {
    if (!participants.includes(playerId)) return null;
    const feedback = normalizeFeedback(message);
    const states = this.#states.get(message.matchId) ?? new Map();
    states.set(playerId, feedback);
    this.#states.set(message.matchId, states);
    return feedback;
  }

  clear(
    playerId: string,
    matchId: string
  ): MatchFeedbackState | null {
    const states = this.#states.get(matchId);
    if (states === undefined || !states.has(playerId)) return null;
    const feedback = hiddenFeedback();
    states.set(playerId, feedback);
    return feedback;
  }
}
