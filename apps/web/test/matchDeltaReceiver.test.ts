import assert from "node:assert/strict";
import test from "node:test";

import type { MatchServerMessage } from "../../../packages/protocol/src/messages.ts";
import { MatchDeltaReceiver } from "../src/game/duel/MatchDeltaReceiver.ts";

type Snapshot = Extract<
  MatchServerMessage,
  { readonly type: "match.snapshot" }
>;
type Delta = Extract<
  MatchServerMessage,
  { readonly type: "match.delta" }
>;

function snapshot(
  stateSequence = 1,
  publicStateHash = `hash-${stateSequence}`
): Snapshot {
  const rows = Object.freeze(Array.from({ length: 40 }, () => 0));
  const garbage = Object.freeze(Array.from({ length: 40 }, () => false));
  const next = ["I", "O", "T", "S", "Z"] as const;
  return Object.freeze({
    type: "match.snapshot",
    matchId: "match-delta-client",
    stateSequence,
    lastEventSequence: 0,
    serverFrame: stateSequence * 8,
    publicStateHash,
    selfStateHash: `self-${stateSequence}`,
    players: Object.freeze([
      Object.freeze({
        playerId: "alice",
        boardRows: rows,
        garbageRows: garbage,
        active: Object.freeze({
          kind: "T" as const,
          rotation: 0,
          x: 3,
          y: 17
        }),
        hold: null,
        next,
        combo: -1,
        backToBack: 0,
        piecesPlaced: 0,
        totalAttackSent: 0,
        pendingGarbage: Object.freeze([]),
        toppedOut: false
      }),
      Object.freeze({
        playerId: "bob",
        boardRows: rows,
        garbageRows: garbage,
        active: Object.freeze({
          kind: "I" as const,
          rotation: 0,
          x: 3,
          y: 17
        }),
        hold: null,
        next,
        combo: -1,
        backToBack: 0,
        piecesPlaced: 0,
        totalAttackSent: 0,
        pendingGarbage: Object.freeze([]),
        toppedOut: false
      })
    ]),
    self: Object.freeze({
      playerId: "alice",
      pieceCursor: 1,
      pieceWindow: next,
      heldInputMask: 0,
      dasFrames: 0,
      arrFrames: 0,
      gravity256: 1,
      lockFrames: 0,
      lockResets: 0,
      canHold: true,
      pendingGarbage: Object.freeze([])
    })
  });
}

function delta(
  baseline: Snapshot,
  overrides: Partial<Delta> = {}
): Delta {
  return Object.freeze({
    type: "match.delta",
    matchId: baseline.matchId,
    stateSequence: baseline.stateSequence + 1,
    baseStateSequence: baseline.stateSequence,
    basePublicStateHash: baseline.publicStateHash,
    lastEventSequence: baseline.lastEventSequence,
    serverFrame: baseline.serverFrame + 8,
    publicStateHash: "hash-next",
    selfStateHash: "self-next",
    patches: Object.freeze([Object.freeze({
      playerId: "alice",
      active: Object.freeze({
        kind: "T",
        rotation: 0,
        x: 2,
        y: 17
      })
    })]),
    events: Object.freeze([]),
    self: Object.freeze({
      ...baseline.self!,
      pieceCursor: 2,
      heldInputMask: 1
    }),
    ...overrides
  });
}

test("valid delta replaces private state and reuses untouched board arrays", () => {
  const receiver = new MatchDeltaReceiver();
  receiver.start("match-delta-client");
  const base = snapshot();
  assert.equal(receiver.acceptSnapshot(base), base);

  const received = receiver.acceptDelta(delta(base));
  assert.notEqual(received.snapshot, null);
  assert.equal(received.resyncRequest, null);
  assert.equal(received.snapshot?.players[0]?.active?.x, 2);
  assert.equal(received.snapshot?.self?.pieceCursor, 2);
  assert.equal(received.snapshot?.self?.heldInputMask, 1);
  assert.equal(
    received.snapshot?.players[0]?.boardRows,
    base.players[0]?.boardRows
  );
  assert.equal(
    received.snapshot?.players[0]?.garbageRows,
    base.players[0]?.garbageRows
  );
});

test("base hash or sequence gap requests one full resync", () => {
  const receiver = new MatchDeltaReceiver();
  receiver.start("match-delta-client");
  const base = snapshot(4, "known-hash");
  receiver.acceptSnapshot(base);
  const broken = delta(base, {
    stateSequence: 6,
    baseStateSequence: 3,
    basePublicStateHash: "wrong"
  });
  const first = receiver.acceptDelta(broken);
  assert.deepEqual(first.resyncRequest, {
    type: "match.resyncRequest",
    matchId: base.matchId,
    lastStateSequence: 4,
    lastEventSequence: 0
  });
  const repeated = receiver.acceptDelta(broken);
  assert.equal(repeated.resyncRequest, null);
  assert.equal(repeated.snapshot, null);
});

test("a reconnect full snapshot resets the delta baseline", () => {
  const receiver = new MatchDeltaReceiver();
  receiver.start("match-delta-client");
  const missing = receiver.acceptDelta(delta(snapshot()));
  assert.equal(missing.resyncRequest?.lastStateSequence, 0);

  const resumed = snapshot(20, "resume-hash");
  assert.equal(receiver.acceptSnapshot(resumed), resumed);
  const continued = receiver.acceptDelta(delta(resumed));
  assert.equal(continued.snapshot?.stateSequence, 21);
  assert.equal(continued.resyncRequest, null);
});
