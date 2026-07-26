import { MatchPieceSequence } from "../matchPieceSequence.ts";
import type { Board } from "../../../../packages/game-core/src/board.ts";
import type {
  ReplayFramePayload,
  ReplayReadResult
} from "../replays/replayTypes.ts";
import { MatchCoordinator } from "./matchCoordinator.ts";
import type { MatchFinishedResult } from "./matchCoordinatorTypes.ts";
import type { MatchEvent } from "../../../../packages/protocol/src/matchMessages.ts";
import {
  createMatchRandomSeedCommitment
} from "./matchReplayCommitment.ts";
import {
  parseAppliedPlayer,
  parsePieceSeed,
  parseReplayControl,
  parseReplayEnd,
  parseReplayMetadata,
  replayArray,
  replayObject
} from "./matchReplayReconstructionParsing.ts";
import type {
  ParsedReplayEnd
} from "./matchReplayReconstructionParsing.ts";
import type { MatchReplayControl } from "./matchReplayRecorderTypes.ts";

export interface MatchReplayReconstruction {
  readonly result: MatchFinishedResult;
  readonly finalStateHashesVerified: boolean;
  readonly events: readonly MatchEvent[];
}

export function reconstructMatchReplay(
  replay: ReplayReadResult,
  options: { readonly initialBoards?: readonly [Board, Board] } = {}
): MatchReplayReconstruction {
  if (!replay.complete || replay.header === null || replay.end === null) {
    throw new Error("Only a verified complete replay can be reconstructed.");
  }
  const metadata = parseReplayMetadata(replay.header.metadata);
  const end = parseReplayEnd(replay.end.data);
  const participants = metadata.players.map(
    (player) => player.playerId
  ) as unknown as readonly [string, string];
  const sequence = new MatchPieceSequence({
    matchId: replay.header.matchId,
    rulesetVersion: metadata.rulesetVersion,
    playerIds: participants,
    seed: parsePieceSeed(end.pieceSeedHex)
  });
  if (sequence.commitment !== metadata.pieceCommitment) {
    throw new Error("Replay piece reveal does not match its commitment.");
  }
  const randomCommitment = createMatchRandomSeedCommitment({
    matchId: replay.header.matchId,
    rulesetVersion: metadata.rulesetVersion,
    seeds: end.randomSeeds
  });
  if (randomCommitment !== metadata.matchRandomCommitment) {
    throw new Error("Replay random reveal does not match its commitment.");
  }

  const resultHolder: { value: MatchFinishedResult | null } = { value: null };
  const match = new MatchCoordinator({
    matchId: replay.header.matchId,
    roomId: `replay:${replay.header.matchId}`,
    participants,
    players: metadata.players,
    sequence,
    tickRateHz: metadata.tickHz,
    randomSeeds: end.randomSeeds,
    ...(options.initialBoards === undefined
      ? {} : { initialBoards: options.initialBoards }),
    onFinished: (finished) => { resultHolder.value = finished; }
  });
  if (
    match.startMessage(participants[0]).garbageTravelFrames
    !== metadata.garbageTravelFrames
  ) {
    throw new Error("Replay garbage timing is unsupported.");
  }

  for (const frame of replay.frames) applyReplayFrame(match, frame);
  advanceTo(match, replay.end.serverFrame);
  if (resultHolder.value === null) forceRecordedEnd(match, end);
  const result = resultHolder.value;
  if (result === null) throw new Error("Replay did not produce a match end.");
  if (
    result.serverFrame !== replay.end.serverFrame
    || result.winnerPlayerId !== end.winnerPlayerId
    || result.reason !== end.reason
  ) {
    throw new Error("Reconstructed match end differs from the replay.");
  }
  const hashesVerified = verifyFinalHashes(
    result.finalStateHashes,
    end.finalStateHashes
  );
  if (end.finalStateHashes !== undefined && !hashesVerified) {
    throw new Error("Reconstructed final state hash differs from the replay.");
  }
  return Object.freeze({
    result,
    finalStateHashesVerified: hashesVerified,
    events: match.view.events
  });
}

function applyReplayFrame(
  match: MatchCoordinator,
  frame: ReplayFramePayload
): void {
  const data = replayObject(frame.data, "replay frame");
  if (data.type === "appliedInputs") {
    advanceTo(match, frame.serverFrame - 1);
    const players = replayArray(data.players, "applied players")
      .map(parseAppliedPlayer);
    for (const player of players) {
      let actionOffset = 0;
      if (player.sourceSequences.length !== player.sources.length) {
        throw new Error("Replay source sequence count does not match.");
      }
      for (const [sourceIndex, source] of player.sources.entries()) {
        if (player.sourceSequences[sourceIndex] !== source.sequence) {
          throw new Error("Replay source sequence differs from its source.");
        }
        const actions = player.actions.slice(
          actionOffset,
          actionOffset + source.actionCount
        );
        actionOffset += source.actionCount;
        const receipt = match.enqueueInput({
          playerId: player.playerId,
          inputEpoch: source.inputEpoch,
          sequence: source.sequence,
          clientFrame: match.view.serverFrame,
          actions
        });
        if (
          receipt.acknowledgement.dispositions[0]?.status !== "scheduled"
        ) {
          throw new Error("Replay input was not accepted for reconstruction.");
        }
      }
      if (actionOffset !== player.actions.length) {
        throw new Error("Replay action source counts do not match.");
      }
    }
    match.advanceOneFrame();
    return;
  }
  if (data.type === "control") {
    advanceTo(match, frame.serverFrame);
    for (const value of replayArray(data.controls, "replay controls")) {
      applyControl(match, parseReplayControl(value));
    }
    return;
  }
  throw new Error("Unknown replay frame type.");
}

function advanceTo(match: MatchCoordinator, targetFrame: number): void {
  if (!Number.isSafeInteger(targetFrame) || targetFrame < 0) {
    throw new Error("Replay frame order is invalid.");
  }
  while (match.view.serverFrame < targetFrame) {
    if (match.view.finished) {
      throw new Error("Replay contains frames after the match ended.");
    }
    match.advanceOneFrame();
  }
  if (match.view.serverFrame !== targetFrame) {
    throw new Error("Replay frames are not monotonic.");
  }
}

function applyControl(
  match: MatchCoordinator,
  control: MatchReplayControl
): void {
  if (control.kind === "clearHeld") {
    match.clearHeldInput(control.playerId);
    return;
  }
  const reset = match.resetInput(control.playerId);
  if (reset.inputEpoch !== control.inputEpoch) {
    throw new Error("Replay reset epoch differs from reconstruction.");
  }
}

function forceRecordedEnd(
  match: MatchCoordinator,
  end: ParsedReplayEnd
): void {
  if (end.reason === "draw") {
    match.forceDraw();
    return;
  }
  if (
    end.reason === "forfeit"
    || end.reason === "disconnect_timeout"
  ) {
    const loser = match.view.participants.find(
      (playerId) => playerId !== end.winnerPlayerId
    );
    if (loser === undefined) throw new Error("Replay has no forced loser.");
    match.forceFinish(loser, end.reason);
    return;
  }
  throw new Error("Natural replay end was not reproduced.");
}

function verifyFinalHashes(
  actual: MatchFinishedResult["finalStateHashes"],
  expected: ParsedReplayEnd["finalStateHashes"]
): boolean {
  return expected !== undefined
    && actual.length === expected.length
    && actual.every((entry, index) =>
      entry.playerId === expected[index]?.playerId
      && entry.hash === expected[index]?.hash
    );
}
