import assert from "node:assert/strict";
import test from "node:test";

import { MatchFeedbackRegistry } from "../src/matches/matchFeedbackRegistry.ts";

const message = {
  type: "match.feedback" as const,
  matchId: "match-1",
  visible: true,
  connected: true,
  armed: true,
  channelA: { strength: 80, limit: 200 },
  channelB: { strength: 10, limit: 30 }
};

test("feedback registry normalizes safe state and hides it on clear", () => {
  const registry = new MatchFeedbackRegistry();
  registry.start("match-1");
  const state = registry.receive("p1", message, ["p1", "p2"]);
  assert.deepEqual(state, {
    visible: true,
    connected: true,
    armed: true,
    channelA: { strength: 80, limit: 200 },
    channelB: { strength: 10, limit: 30 }
  });
  assert.deepEqual(registry.snapshots("match-1", ["p1", "p2"]), [
    { type: "match.feedback", matchId: "match-1", playerId: "p1", feedback: {
      visible: true,
      connected: true,
      armed: true,
      channelA: { strength: 80, limit: 200 },
      channelB: { strength: 10, limit: 30 }
    } },
    { type: "match.feedback", matchId: "match-1", playerId: "p2", feedback: {
      visible: false,
      connected: false,
      armed: false,
      channelA: { strength: 0, limit: 0 },
      channelB: { strength: 0, limit: 0 }
    } }
  ]);
  assert.deepEqual(registry.clear("p1", "match-1"), {
    visible: false,
    connected: false,
    armed: false,
    channelA: { strength: 0, limit: 0 },
    channelB: { strength: 0, limit: 0 }
  });
  assert.equal(registry.receive("spectator", message, ["p1", "p2"]), null);
  registry.clearAll();
  assert.equal(registry.snapshots("match-1", ["p1"]).length, 1);
});
