import assert from "node:assert/strict";
import test from "node:test";

import { RULESET_VERSION } from "../../../packages/protocol/src/versions.ts";
import { MatchPieceSequence } from "../src/matchPieceSequence.ts";
import {
  SequencePieceSource,
  mapDisposition,
  netPacketLists
} from "../src/matches/matchCoordinatorHelpers.ts";

test("SequencePieceSource exposes preview, draw, and independent cursor", () => {
  const sequence = new MatchPieceSequence({
    matchId: "helper-match",
    rulesetVersion: RULESET_VERSION,
    playerIds: ["alice", "bob"],
    seed: [1, 2, 3, 4]
  });
  const source = new SequencePieceSource(sequence, "alice");
  const preview = source.peek(3);

  assert.equal(source.getCursor(), 0);
  assert.equal(source.draw(), preview[0]);
  assert.equal(source.getCursor(), 1);
  assert.equal(sequence.getCursor("bob"), 0);
});

test("mapDisposition preserves public reasons and hides internal reasons", () => {
  assert.deepEqual(mapDisposition({
    status: "rejected",
    sequence: 2,
    reason: "too_far_future"
  }), {
    status: "rejected",
    sequence: 2,
    reason: "too_far_future"
  });
  assert.deepEqual(mapDisposition({
    status: "rejected",
    sequence: 3,
    reason: "wrong_epoch"
  }), {
    status: "rejected",
    sequence: 3,
    reason: "invalid"
  });
});

test("netPacketLists cancels FIFO amounts without mutating inputs", () => {
  const first = [5, 2];
  const second = [3, 1];
  const netted = netPacketLists(first, second);

  assert.deepEqual(netted, [[1, 2], []]);
  assert.deepEqual(first, [5, 2]);
  assert.deepEqual(second, [3, 1]);
  assert.equal(Object.isFrozen(netted[0]), true);
  assert.equal(Object.isFrozen(netted[1]), true);
});
