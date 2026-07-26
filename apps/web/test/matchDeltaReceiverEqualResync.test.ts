import assert from "node:assert/strict";
import test from "node:test";

import type {
  MatchServerMessage
} from "../../../packages/protocol/src/messages.ts";
import { MatchDeltaReceiver } from "../src/game/duel/MatchDeltaReceiver.ts";

type Snapshot = Extract<
  MatchServerMessage,
  { readonly type: "match.snapshot" }
>;
type Delta = Extract<
  MatchServerMessage,
  { readonly type: "match.delta" }
>;

function snapshot(sequence: number, hash: string): Snapshot {
  const rows = Object.freeze(Array.from({ length: 40 }, () => 0));
  const garbage = Object.freeze(Array.from({ length: 40 }, () => false));
  return Object.freeze({
    type: "match.snapshot",
    matchId: "equal-resync",
    stateSequence: sequence,
    lastEventSequence: 0,
    serverFrame: sequence * 8,
    publicStateHash: hash,
    selfStateHash: `self-${hash}`,
    players: Object.freeze([Object.freeze({
      playerId: "alice",
      boardRows: rows,
      garbageRows: garbage,
      active: null,
      hold: null,
      next: Object.freeze([]),
      combo: -1,
      backToBack: 0,
      piecesPlaced: 0,
      totalAttackSent: 0,
      pendingGarbage: Object.freeze([]),
      toppedOut: false
    })]),
    self: null
  });
}

function brokenDelta(base: Snapshot): Delta {
  return Object.freeze({
    type: "match.delta",
    matchId: base.matchId,
    stateSequence: base.stateSequence + 1,
    baseStateSequence: base.stateSequence,
    basePublicStateHash: "mismatched-hash",
    lastEventSequence: base.lastEventSequence,
    serverFrame: base.serverFrame + 8,
    publicStateHash: "unused",
    selfStateHash: null,
    patches: Object.freeze([]),
    events: Object.freeze([]),
    self: null
  });
}

test("equal-sequence full snapshot completes an outstanding resync", () => {
  const receiver = new MatchDeltaReceiver();
  receiver.start("equal-resync");
  const initial = snapshot(4, "known-hash");
  assert.equal(receiver.acceptSnapshot(initial), initial);
  assert.notEqual(receiver.acceptDelta(brokenDelta(initial)).resyncRequest, null);

  const replacement = snapshot(4, "server-full-hash");
  assert.equal(receiver.acceptSnapshot(replacement), replacement);

  assert.notEqual(receiver.acceptDelta(brokenDelta(replacement)).resyncRequest, null);
});

test("equal snapshot remains stale without an outstanding resync", () => {
  const receiver = new MatchDeltaReceiver();
  receiver.start("equal-resync");
  const initial = snapshot(4, "known-hash");
  receiver.acceptSnapshot(initial);
  assert.equal(receiver.acceptSnapshot(snapshot(4, "duplicate")), null);
  assert.equal(receiver.acceptSnapshot(snapshot(3, "older")), null);
});
