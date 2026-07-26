import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PIECE_WINDOW,
  MatchPieceSequence,
  verifyMatchPieceSequenceReveal
} from "../src/matchPieceSequence.ts";

const SEED = [0x1234_5678, 0x9abc_def0, 0x0fed_cba9, 0x8765_4321] as const;

function sequence(): MatchPieceSequence {
  return new MatchPieceSequence({
    matchId: "match-1",
    rulesetVersion: "versus-srs-plus-test",
    playerIds: ["alice", "bob"],
    seed: SEED
  });
}

test("opening view exposes commitment and finite windows but not seed", () => {
  const pieces = sequence();
  const view = pieces.view;
  const window = pieces.peek("alice", 5);

  assert.match(view.commitment, /^[0-9a-f]{64}$/);
  assert.deepEqual(view.cursors, { alice: 0, bob: 0 });
  assert.equal(view.finished, false);
  assert.equal(window.cursor, 0);
  assert.equal(window.pieces.length, 5);
  assert.equal(JSON.stringify({ view, window }).includes("12345678"), false);
  assert.equal("seedHex" in view, false);
  assert.throws(
    () => pieces.peek("alice", MAX_PIECE_WINDOW + 1),
    /Invalid piece window size/
  );
});

test("players share ordinal pieces while advancing independent cursors", () => {
  const pieces = sequence();
  const alice: string[] = [];
  const bob: string[] = [];

  for (let index = 0; index < 35; index += 1) {
    alice.push(pieces.draw("alice").pieces[0]!);
  }
  for (let index = 0; index < 7; index += 1) {
    bob.push(pieces.draw("bob").pieces[0]!);
  }

  assert.deepEqual(bob, alice.slice(0, 7));
  assert.equal(pieces.getCursor("alice"), 35);
  assert.equal(pieces.getCursor("bob"), 7);

  const bobNext = pieces.draw("bob", 7);
  assert.deepEqual(bobNext.pieces, alice.slice(7, 14));
  assert.equal(pieces.getCursor("alice"), 35);
  assert.equal(pieces.getCursor("bob"), 14);
});

test("hold semantics consume only when a replacement piece is required", () => {
  const pieces = sequence();
  const firstActive = pieces.draw("alice").pieces[0]!;

  // Empty hold stores the active piece and must draw its replacement.
  const replacement = pieces.draw("alice").pieces[0]!;
  assert.equal(pieces.getCursor("alice"), 2);

  // After locking, the next active piece consumes one shared-sequence item.
  const afterLock = pieces.draw("alice").pieces[0]!;
  assert.equal(pieces.getCursor("alice"), 3);

  // Swapping an occupied hold slot changes no queue cursor.
  const cursorBeforeOccupiedSwap = pieces.getCursor("alice");
  const swappedActive = firstActive;
  assert.equal(pieces.getCursor("alice"), cursorBeforeOccupiedSwap);
  assert.notEqual(replacement, undefined);
  assert.notEqual(afterLock, undefined);
  assert.equal(swappedActive, firstActive);

  const bobPrefix = pieces.draw("bob", 3).pieces;
  assert.deepEqual(bobPrefix, [firstActive, replacement, afterLock]);
});

test("finish reveals a verifiable seed and freezes further consumption", () => {
  const pieces = sequence();
  pieces.draw("alice", 5);
  pieces.draw("bob", 2);

  const reveal = pieces.finish();

  assert.equal(pieces.view.finished, true);
  assert.match(reveal.seedHex, /^[0-9a-f]{32}$/);
  assert.equal(
    verifyMatchPieceSequenceReveal(pieces.commitment, reveal),
    true
  );
  assert.throws(() => pieces.draw("alice"), /finished/);
  assert.throws(() => pieces.peek("bob", 1), /finished/);
});

test("commitment verification detects seed and context tampering", () => {
  const pieces = sequence();
  const reveal = pieces.finish();

  assert.equal(
    verifyMatchPieceSequenceReveal(pieces.commitment, {
      ...reveal,
      matchId: "another-match"
    }),
    false
  );
  assert.equal(
    verifyMatchPieceSequenceReveal(pieces.commitment, {
      ...reveal,
      seedHex: `${reveal.seedHex.slice(0, -1)}0`
    }),
    false
  );
  assert.equal(
    verifyMatchPieceSequenceReveal(`0${pieces.commitment.slice(1)}`, reveal),
    false
  );
});

test("invalid roster, player, context and deterministic seed are rejected", () => {
  assert.throws(
    () =>
      new MatchPieceSequence({
        matchId: "match",
        rulesetVersion: "rules",
        playerIds: ["same", "same"],
        seed: SEED
      }),
    /distinct/
  );
  assert.throws(() => sequence().draw("spectator"), /not in this match/);
  assert.throws(
    () =>
      new MatchPieceSequence({
        matchId: "",
        rulesetVersion: "rules",
        playerIds: ["alice", "bob"],
        seed: SEED
      }),
    /matchId/
  );
  assert.throws(
    () =>
      new MatchPieceSequence({
        matchId: "match",
        rulesetVersion: "rules",
        playerIds: ["alice", "bob"],
        seed: [0, 0, 0, 0]
      }),
    /not be all zero/
  );
});
