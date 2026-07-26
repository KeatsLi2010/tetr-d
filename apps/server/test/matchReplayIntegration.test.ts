import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FULL_ROW_MASK,
  createBoard
} from "../../../packages/game-core/src/index.ts";
import { RULESET_VERSION } from "../../../packages/protocol/src/versions.ts";
import { MatchPieceSequence } from "../src/matchPieceSequence.ts";
import { MatchCoordinator } from "../src/matches/matchCoordinator.ts";
import type {
  MatchFinishedResult
} from "../src/matches/matchCoordinatorTypes.ts";
import { MatchReplayPersistence } from "../src/matches/matchReplayPersistence.ts";
import {
  reconstructMatchReplay
} from "../src/matches/matchReplayReconstructor.ts";
import { readReplay } from "../src/replays/replayReader.ts";

const MATCH_ID = "persistent-integration";
const PARTICIPANTS = ["alice", "bob"] as const;
const PLAYERS = [
  { playerId: "alice", displayName: "Alice" },
  { playerId: "bob", displayName: "Bob" }
] as const;
const PIECE_SEED = [
  123456789,
  362436069,
  521288629,
  88675123
] as const;
const RANDOM_SEEDS = {
  firstAttack: 11,
  secondAttack: 22,
  garbageHole: 33
} as const;

async function replayRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tetr-d-replay-integration-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("authority replay reconstructs actions, controls, garbage and final hash",
  async (t) => {
    const rootDirectory = await replayRoot(t);
    const sequence = new MatchPieceSequence({
      matchId: MATCH_ID,
      rulesetVersion: RULESET_VERSION,
      playerIds: PARTICIPANTS,
      seed: PIECE_SEED
    });
    const missingColumn = FULL_ROW_MASK ^ (1 << 5);
    const initialBoards = [
      createBoard([
        missingColumn,
        missingColumn,
        missingColumn,
        missingColumn
      ]),
      createBoard()
    ] as const;
    const persistence = new MatchReplayPersistence({
      rootDirectory,
      serverVersion: "integration-test",
      tickRateHz: 240,
      now: () => 123
    });
    let finish: MatchFinishedResult | null = null;
    let replayFinalized: Promise<void> = Promise.resolve();
    const match = new MatchCoordinator({
      matchId: MATCH_ID,
      roomId: "room-replay",
      participants: PARTICIPANTS,
      players: PLAYERS,
      sequence,
      tickRateHz: 240,
      randomSeeds: RANDOM_SEEDS,
      initialBoards,
      onAppliedFrame: (frame) =>
        persistence.recordAppliedFrame(MATCH_ID, frame),
      onControlFrame: (frame) =>
        persistence.recordControlFrame(MATCH_ID, frame),
      onFinished: (result) => {
        finish = result;
        replayFinalized = persistence.finalize(MATCH_ID, {
          serverFrame: result.serverFrame,
          winnerPlayerId: result.winnerPlayerId,
          reason: result.reason,
          randomSeedReveal: result.randomSeedReveal,
          finalStateHashes: result.finalStateHashes
        });
      }
    });
    persistence.start({
      matchId: MATCH_ID,
      players: PLAYERS,
      sequence,
      randomSeeds: RANDOM_SEEDS,
      garbageTravelFrames:
        match.startMessage(PARTICIPANTS[0]).garbageTravelFrames
    });

    match.enqueueInput({
      playerId: "alice",
      inputEpoch: 0,
      sequence: 0,
      clientFrame: 0,
      actions: [
        { kind: "move", direction: "left", pressed: true },
        { kind: "hold" },
        { kind: "rotate", direction: "cw" },
        { kind: "hardDrop" }
      ]
    });
    match.advanceOneFrame();
    const originalGarbageEvent = match.view.events[0];
    assert.equal(originalGarbageEvent?.kind, "garbage.queued");
    assert.equal(originalGarbageEvent?.packet.amount, 9);
    match.clearHeldInput("alice");
    const reset = match.resetInput("bob");
    assert.equal(reset.inputEpoch, 1);

    while (match.view.serverFrame < 80) match.advanceOneFrame();
    match.enqueueInput({
      playerId: "bob",
      inputEpoch: 1,
      sequence: 0,
      clientFrame: 80,
      actions: [{ kind: "hardDrop" }]
    });
    match.advanceOneFrame();
    assert.equal(
      match.view.simulations[1].view.board.garbageRows.some(Boolean),
      true
    );
    assert.equal(match.forceFinish("bob", "forfeit"), true);
    await replayFinalized;
    assert.notEqual(finish, null);

    const replay = await readReplay({
      rootDirectory,
      matchId: MATCH_ID
    });
    assert.equal(replay.complete, true);
    assert.equal(replay.records[0]?.previousHash, null);
    replay.records.slice(1).forEach((record, index) => {
      assert.equal(record.previousHash, replay.records[index]?.hash);
    });
    const frameKinds = replay.frames.map((frame) =>
      (frame.data as { type: string }).type
    );
    assert.deepEqual(frameKinds, [
      "appliedInputs",
      "control",
      "control",
      "appliedInputs"
    ]);
    const controlFrames = replay.frames.filter((frame) =>
      (frame.data as { type: string }).type === "control"
    );
    assert.deepEqual(
      controlFrames.map((frame) =>
        (frame.data as {
          controls: readonly { kind: string }[];
        }).controls[0]?.kind
      ),
      ["clearHeld", "resetInput"]
    );

    const reconstructed = reconstructMatchReplay(replay, { initialBoards });
    assert.equal(reconstructed.finalStateHashesVerified, true);
    assert.deepEqual(
      reconstructed.result.finalStateHashes,
      finish!.finalStateHashes
    );
    const reconstructedGarbage = reconstructed.events[0];
    assert.equal(reconstructedGarbage?.kind, "garbage.queued");
    assert.equal(
      reconstructedGarbage?.holeSeed,
      originalGarbageEvent?.holeSeed
    );
    const end = replay.end?.data as {
      randomSeedReveal: {
        firstAttack: number;
        secondAttack: number;
        garbageHole: number;
      };
    };
    assert.deepEqual(
      {
        firstAttack: end.randomSeedReveal.firstAttack,
        secondAttack: end.randomSeedReveal.secondAttack,
        garbageHole: end.randomSeedReveal.garbageHole
      },
      RANDOM_SEEDS
    );
  }
);

test("closing an unfinished replay preserves only a partial file", async (t) => {
  const rootDirectory = await replayRoot(t);
  const sequence = new MatchPieceSequence({
    matchId: `${MATCH_ID}-partial`,
    rulesetVersion: RULESET_VERSION,
    playerIds: PARTICIPANTS,
    seed: PIECE_SEED
  });
  const persistence = new MatchReplayPersistence({
    rootDirectory,
    serverVersion: "integration-test",
    tickRateHz: 240
  });
  persistence.start({
    matchId: `${MATCH_ID}-partial`,
    players: PLAYERS,
    sequence,
    randomSeeds: RANDOM_SEEDS,
    garbageTravelFrames: 80
  });
  await persistence.closePartial(`${MATCH_ID}-partial`);
  const replay = await readReplay({
    rootDirectory,
    matchId: `${MATCH_ID}-partial`,
    source: "partial"
  });
  assert.equal(replay.complete, false);
  assert.equal(replay.stopReason, "eof-without-end");
});
