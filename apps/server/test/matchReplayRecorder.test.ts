import assert from "node:assert/strict";
import {
  mkdtemp,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MatchPieceSequence
} from "../src/matchPieceSequence.ts";
import {
  MatchInputQueue
} from "../src/matches/matchInputQueue.ts";
import {
  createMatchRandomSeedCommitment,
  verifyMatchRandomSeedReveal
} from "../src/matches/matchReplayCommitment.ts";
import {
  MatchReplayRecorder
} from "../src/matches/matchReplayRecorder.ts";
import {
  readReplay
} from "../src/replays/replayReader.ts";

const MATCH_ID = "match-recorder";
const RULESET_VERSION = "versus-srs-plus-test";
const MATCH_SEEDS = {
  firstAttack: 11,
  secondAttack: 22,
  garbageHole: 33
} as const;

async function replayRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tetr-d-match-replay-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function pieceSequence(): MatchPieceSequence {
  return new MatchPieceSequence({
    matchId: MATCH_ID,
    rulesetVersion: RULESET_VERSION,
    playerIds: ["p1", "p2"],
    seed: [1, 2, 3, 4]
  });
}

async function recorder(
  rootDirectory: string,
  sequence: MatchPieceSequence,
  maxPendingRecords = 32
): Promise<MatchReplayRecorder> {
  return MatchReplayRecorder.create({
    rootDirectory,
    matchId: MATCH_ID,
    createdAtMs: 100,
    serverVersion: "server-test",
    protocolVersion: 4,
    rulesetVersion: RULESET_VERSION,
    rotationSystemVersion: "srs-plus-v1",
    pieceSequenceVersion: "shared-seven-bag-v1",
    tickHz: 240,
    garbageTravelFrames: 120,
    players: [
      { playerId: "p1", displayName: "One" },
      { playerId: "p2", displayName: "Two" }
    ],
    randomSeedCommitment: {
      pieceSequence: sequence.commitment,
      matchRandom: createMatchRandomSeedCommitment({
        matchId: MATCH_ID,
        rulesetVersion: RULESET_VERSION,
        seeds: MATCH_SEEDS
      })
    },
    maxPendingRecords
  });
}

test("records an action-driven log in participant order", async (t) => {
  const rootDirectory = await replayRoot(t);
  const sequence = pieceSequence();
  const output = await recorder(rootDirectory, sequence);
  const queue = new MatchInputQueue(["p1", "p2"], {
    inputDelayFrames: 0
  });
  queue.enqueue({
    playerId: "p2",
    inputEpoch: 0,
    sequence: 0,
    clientFrame: 4,
    actions: [
      { kind: "rotate", direction: "cw" },
      { kind: "hardDrop" }
    ]
  }, 4);
  queue.enqueue({
    playerId: "p1",
    inputEpoch: 0,
    sequence: 0,
    clientFrame: 4,
    actions: [{ kind: "moveStep", direction: "left" }]
  }, 4);
  queue.enqueue({
    playerId: "p1",
    inputEpoch: 0,
    sequence: 1,
    clientFrame: 4,
    actions: [{ kind: "hardDrop" }]
  }, 4);

  await output.recordAppliedFrame({
    serverFrame: 3,
    drainedInputs: []
  });
  await output.recordAppliedFrame({
    serverFrame: 4,
    drainedInputs: queue.drain(4)
  });
  await output.recordControlFrame({
    serverFrame: 4,
    controls: [
      { kind: "clearHeld", playerId: "p2" },
      { kind: "resetInput", playerId: "p1", inputEpoch: 1 }
    ]
  });
  await output.finalize({
    serverFrame: 5,
    winnerPlayerId: "p1",
    reason: "topout",
    randomSeedReveal: {
      pieceSequence: sequence.finish(),
      matchRandom: MATCH_SEEDS
    },
    finalStateHashes: [
      { playerId: "p1", hash: "1".repeat(64) },
      { playerId: "p2", hash: "2".repeat(64) }
    ]
  });

  const replay = await readReplay({ rootDirectory, matchId: MATCH_ID });
  assert.equal(replay.complete, true);
  assert.equal(replay.frames.length, 2);
  const applied = replay.frames[0]!.data as {
    type: string;
    players: {
      playerId: string;
      actions: unknown[];
      sourceSequences: number[];
      sources: { actionCount: number }[];
    }[];
  };
  assert.equal(applied.type, "appliedInputs");
  assert.deepEqual(
    applied.players.map((player) => player.playerId),
    ["p1", "p2"]
  );
  assert.deepEqual(applied.players[0]!.sourceSequences, [0, 1]);
  assert.deepEqual(
    applied.players[0]!.sources.map((source) => source.actionCount),
    [1, 1]
  );
  assert.deepEqual(
    applied.players[0]!.actions.map((action) =>
      (action as { kind: string }).kind
    ),
    ["moveStep", "hardDrop"]
  );
  assert.deepEqual(
    applied.players[1]!.actions.map((action) =>
      (action as { kind: string }).kind
    ),
    ["rotate", "hardDrop"]
  );
  const control = replay.frames[1]!.data as {
    type: string;
    controls: { kind: string; playerId: string }[];
  };
  assert.equal(control.type, "control");
  assert.deepEqual(
    control.controls.map((entry) => `${entry.kind}:${entry.playerId}`),
    ["clearHeld:p2", "resetInput:p1"]
  );
});

test("header hides seeds and handling while end reveals verified seeds", async (t) => {
  const rootDirectory = await replayRoot(t);
  const sequence = pieceSequence();
  const output = await recorder(rootDirectory, sequence);
  await output.finalize({
    serverFrame: 0,
    winnerPlayerId: null,
    reason: "draw",
    randomSeedReveal: {
      pieceSequence: sequence.finish(),
      matchRandom: MATCH_SEEDS
    }
  });

  const replay = await readReplay({ rootDirectory, matchId: MATCH_ID });
  const metadataText = JSON.stringify(replay.header?.metadata);
  assert.equal(metadataText.includes("firstAttack"), false);
  assert.equal(metadataText.includes("garbageHole"), false);
  assert.equal(metadataText.toLowerCase().includes("handling"), false);
  assert.deepEqual(
    Object.keys(replay.header?.metadata ?? {}).sort(),
    [
      "garbageTravelFrames",
      "pieceSequenceVersion",
      "players",
      "protocolVersion",
      "randomSeedCommitment",
      "rotationSystemVersion",
      "rulesetVersion",
      "serverVersion",
      "tickHz"
    ]
  );
  const end = replay.end?.data as {
    randomSeedReveal: {
      pieceSequenceSeedHex: string;
      firstAttack: number;
      secondAttack: number;
      garbageHole: number;
    };
  };
  assert.equal(end.randomSeedReveal.pieceSequenceSeedHex.length, 32);
  assert.deepEqual(
    {
      firstAttack: end.randomSeedReveal.firstAttack,
      secondAttack: end.randomSeedReveal.secondAttack,
      garbageHole: end.randomSeedReveal.garbageHole
    },
    MATCH_SEEDS
  );
});

test("match random commitment verifies context and all three streams", () => {
  const commitment = createMatchRandomSeedCommitment({
    matchId: MATCH_ID,
    rulesetVersion: RULESET_VERSION,
    seeds: MATCH_SEEDS
  });
  assert.equal(verifyMatchRandomSeedReveal(commitment, {
    matchId: MATCH_ID,
    rulesetVersion: RULESET_VERSION,
    seeds: MATCH_SEEDS
  }), true);
  assert.equal(verifyMatchRandomSeedReveal(commitment, {
    matchId: MATCH_ID,
    rulesetVersion: RULESET_VERSION,
    seeds: { ...MATCH_SEEDS, garbageHole: 34 }
  }), false);
  assert.equal(verifyMatchRandomSeedReveal(commitment, {
    matchId: `${MATCH_ID}-other`,
    rulesetVersion: RULESET_VERSION,
    seeds: MATCH_SEEDS
  }), false);
});

test("recorder propagates bounded writer backpressure", async (t) => {
  const rootDirectory = await replayRoot(t);
  const sequence = pieceSequence();
  const output = await recorder(rootDirectory, sequence, 1);
  const input = {
    playerId: "p1",
    inputEpoch: 0,
    sequence: 0,
    clientFrame: 1,
    serverFrame: 1,
    actions: [{ kind: "hardDrop" }] as const
  };
  const first = output.recordAppliedFrame({
    serverFrame: 1,
    drainedInputs: [input]
  });
  assert.throws(
    () => output.recordControlFrame({
      serverFrame: 1,
      controls: [{ kind: "clearHeld", playerId: "p1" }]
    }),
    /pending records/
  );
  await first;
  await output.recordControlFrame({
    serverFrame: 1,
    controls: [{ kind: "clearHeld", playerId: "p1" }]
  });
  await output.finalize({
    serverFrame: 2,
    winnerPlayerId: null,
    reason: "draw",
    randomSeedReveal: {
      pieceSequence: sequence.finish(),
      matchRandom: MATCH_SEEDS
    }
  });
});
