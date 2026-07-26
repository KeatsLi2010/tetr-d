import assert from "node:assert/strict";
import test from "node:test";

import { MatchInputQueue } from "../src/matches/matchInputQueue.ts";

const hardDrop = [{ kind: "hardDrop" as const }];

test("inputs are sequenced and applied on the next authoritative frame", () => {
  const queue = new MatchInputQueue(["alice", "bob"]);
  assert.deepEqual(queue.enqueue({
    playerId: "alice",
    inputEpoch: 0,
    sequence: 0,
    clientFrame: 8,
    actions: hardDrop
  }, 10), { status: "scheduled", sequence: 0, serverFrame: 11 });
  assert.deepEqual(queue.drain(10), []);
  assert.equal(queue.drain(11)[0]?.playerId, "alice");
  assert.deepEqual(queue.enqueue({
    playerId: "alice",
    inputEpoch: 0,
    sequence: 0,
    clientFrame: 8,
    actions: hardDrop
  }, 11), { status: "applied", sequence: 0, serverFrame: 11 });
});

test("gaps, stale client frames and future client frames are rejected", () => {
  const queue = new MatchInputQueue(["alice", "bob"], {
    maxClientFrameLag: 5,
    maxClientFrameLead: 5
  });
  const make = (sequence: number, clientFrame: number) => ({
    playerId: "alice",
    inputEpoch: 0,
    sequence,
    clientFrame,
    actions: hardDrop
  });
  assert.equal(queue.enqueue(make(1, 20), 20).status, "rejected");
  assert.deepEqual(queue.enqueue(make(0, 14), 20), {
    status: "rejected", sequence: 0, reason: "late"
  });
  assert.deepEqual(queue.enqueue(make(0, 26), 20), {
    status: "rejected", sequence: 0, reason: "too_far_future"
  });
});

test("reset increments epoch and discards only that player's queued input", () => {
  const queue = new MatchInputQueue(["alice", "bob"]);
  for (const playerId of ["alice", "bob"] as const) {
    queue.enqueue({
      playerId,
      inputEpoch: 0,
      sequence: 0,
      clientFrame: 0,
      actions: hardDrop
    }, 0);
  }
  assert.deepEqual(queue.resetPlayer("alice"), {
    inputEpoch: 1,
    nextSequence: 0
  });
  assert.deepEqual(queue.viewPlayer("alice"), {
    inputEpoch: 1,
    nextSequence: 0
  });
  assert.deepEqual(queue.drain(1).map((input) => input.playerId), ["bob"]);
  assert.equal(queue.enqueue({
    playerId: "alice",
    inputEpoch: 0,
    sequence: 0,
    clientFrame: 1,
    actions: hardDrop
  }, 1).status, "rejected");
});

test("same-frame inputs use stable roster order", () => {
  const queue = new MatchInputQueue(["alice", "bob"]);
  for (const playerId of ["bob", "alice"] as const) {
    queue.enqueue({
      playerId,
      inputEpoch: 0,
      sequence: 0,
      clientFrame: 4,
      actions: hardDrop
    }, 4);
  }
  assert.deepEqual(queue.drain(5).map((input) => input.playerId), ["alice", "bob"]);
});
