import {
  verifyMatchPieceSequenceReveal
} from "../matchPieceSequence.ts";
import {
  ReplayWriter
} from "../replays/replayWriter.ts";
import {
  assertReplayJsonValue
} from "../replays/replayTypes.ts";
import type {
  ReplayJsonObject,
  ReplayJsonValue
} from "../replays/replayTypes.ts";
import {
  verifyMatchRandomSeedReveal
} from "./matchReplayCommitment.ts";
import type {
  MatchReplayAppliedFrame,
  MatchReplayControl,
  MatchReplayControlFrame,
  MatchReplayFinalize,
  MatchReplayPlayerActions,
  MatchReplayRecorderOptions
} from "./matchReplayRecorderTypes.ts";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const END_REASONS = new Set([
  "topout",
  "forfeit",
  "disconnect_timeout",
  "simultaneous_topout",
  "draw"
]);

export class MatchReplayRecorder {
  readonly #writer: ReplayWriter;
  readonly #matchId: string;
  readonly #rulesetVersion: string;
  readonly #playerIds: readonly [string, string];
  readonly #pieceCommitment: string;
  readonly #matchRandomCommitment: string;
  #phase: "open" | "finalizing" = "open";
  #lastAppliedFrame = -1;
  #lastRecordedFrame = -1;
  #finalizePromise: Promise<string> | undefined;
  #closePartialPromise: Promise<void> | undefined;

  private constructor(
    writer: ReplayWriter,
    options: MatchReplayRecorderOptions
  ) {
    this.#writer = writer;
    this.#matchId = options.matchId;
    this.#rulesetVersion = options.rulesetVersion;
    this.#playerIds = Object.freeze([
      options.players[0].playerId,
      options.players[1].playerId
    ]);
    this.#pieceCommitment =
      options.randomSeedCommitment.pieceSequence;
    this.#matchRandomCommitment =
      options.randomSeedCommitment.matchRandom;
  }

  static async create(
    options: MatchReplayRecorderOptions
  ): Promise<MatchReplayRecorder> {
    validateOptions(options);
    const metadata = replayJson({
      serverVersion: options.serverVersion,
      protocolVersion: options.protocolVersion,
      rulesetVersion: options.rulesetVersion,
      rotationSystemVersion: options.rotationSystemVersion,
      pieceSequenceVersion: options.pieceSequenceVersion,
      tickHz: options.tickHz,
      garbageTravelFrames: options.garbageTravelFrames,
      players: options.players.map((player) => ({
        playerId: player.playerId,
        displayName: player.displayName
      })),
      randomSeedCommitment: {
        pieceSequence: options.randomSeedCommitment.pieceSequence,
        matchRandom: options.randomSeedCommitment.matchRandom
      }
    }) as ReplayJsonObject;
    if (
      typeof metadata !== "object"
      || metadata === null
      || Array.isArray(metadata)
    ) {
      throw new TypeError("Replay metadata must be an object.");
    }
    const writer = await ReplayWriter.create({
      rootDirectory: options.rootDirectory,
      header: {
        kind: "header",
        version: 1,
        matchId: options.matchId,
        createdAtMs: options.createdAtMs,
        metadata
      },
      ...(options.maxPendingRecords === undefined
        ? {}
        : { maxPendingRecords: options.maxPendingRecords })
    });
    return new MatchReplayRecorder(writer, options);
  }

  get pendingCount(): number {
    return this.#writer.pendingCount;
  }

  get partialPath(): string {
    return this.#writer.partialPath;
  }

  get finalPath(): string {
    return this.#writer.finalPath;
  }

  closePartial(): Promise<void> {
    if (this.#closePartialPromise !== undefined) {
      return this.#closePartialPromise;
    }
    this.#closePartialPromise = this.#writer.closePartial();
    return this.#closePartialPromise;
  }

  /**
   * Intended as the coordinator's onAppliedFrame hook. Idle frames are
   * observed for ordering but deliberately omitted from the action log.
   */
  recordAppliedFrame(frame: MatchReplayAppliedFrame): Promise<void> {
    this.#assertOpen();
    validateFrame(frame.serverFrame);
    if (frame.serverFrame <= this.#lastAppliedFrame) {
      throw new RangeError("Applied replay frames must strictly increase.");
    }
    if (frame.serverFrame < Math.max(
      this.#lastAppliedFrame,
      this.#lastRecordedFrame
    )) {
      throw new RangeError("Applied replay frame is behind the log.");
    }
    const grouped = this.#groupInputs(frame);
    if (grouped.length === 0) {
      this.#lastAppliedFrame = frame.serverFrame;
      return Promise.resolve();
    }
    const write = this.#writer.appendFrame({
      kind: "frame",
      serverFrame: frame.serverFrame,
      data: replayJson({
        type: "appliedInputs",
        players: grouped
      })
    });
    this.#lastAppliedFrame = frame.serverFrame;
    this.#lastRecordedFrame = frame.serverFrame;
    return write;
  }

  recordControlFrame(frame: MatchReplayControlFrame): Promise<void> {
    this.#assertOpen();
    validateFrame(frame.serverFrame);
    if (frame.serverFrame < Math.max(
      this.#lastAppliedFrame,
      this.#lastRecordedFrame
    )) {
      throw new RangeError("Control replay frame is behind the log.");
    }
    if (frame.controls.length === 0) {
      throw new TypeError("Control replay frame cannot be empty.");
    }
    const controls = frame.controls.map((control) =>
      this.#validatedControl(control)
    );
    const write = this.#writer.appendFrame({
      kind: "frame",
      serverFrame: frame.serverFrame,
      data: replayJson({ type: "control", controls })
    });
    this.#lastRecordedFrame = frame.serverFrame;
    return write;
  }

  finalize(result: MatchReplayFinalize): Promise<string> {
    if (this.#finalizePromise !== undefined) return this.#finalizePromise;
    this.#assertOpen();
    this.#validateFinish(result);
    this.#phase = "finalizing";
    const endData: Record<string, unknown> = {
      type: "matchEnd",
      winnerPlayerId: result.winnerPlayerId,
      reason: result.reason,
      randomSeedReveal: {
        pieceSequenceSeedHex:
          result.randomSeedReveal.pieceSequence.seedHex,
        firstAttack: result.randomSeedReveal.matchRandom.firstAttack,
        secondAttack: result.randomSeedReveal.matchRandom.secondAttack,
        garbageHole: result.randomSeedReveal.matchRandom.garbageHole
      }
    };
    if (result.finalStateHashes !== undefined) {
      endData.finalStateHashes = result.finalStateHashes.map((entry) => ({
        playerId: entry.playerId,
        hash: entry.hash
      }));
    }
    this.#finalizePromise = this.#writer.finalize({
      kind: "end",
      serverFrame: result.serverFrame,
      data: replayJson(endData)
    });
    return this.#finalizePromise;
  }

  #groupInputs(
    frame: MatchReplayAppliedFrame
  ): readonly MatchReplayPlayerActions[] {
    for (const input of frame.drainedInputs) {
      if (!this.#playerIds.includes(input.playerId)) {
        throw new RangeError("Drained input player is not in this match.");
      }
      if (
        !validCounter(input.inputEpoch)
        || !validCounter(input.sequence)
        || !validCounter(input.clientFrame)
        || !validCounter(input.serverFrame)
        || input.serverFrame > frame.serverFrame
        || input.actions.length === 0
      ) {
        throw new TypeError("Invalid drained replay input.");
      }
      for (const action of input.actions) replayJson(action);
    }
    return this.#playerIds.flatMap((playerId) => {
      const inputs = frame.drainedInputs.filter(
        (input) => input.playerId === playerId
      );
      if (inputs.length === 0) return [];
      return [{
        playerId,
        actions: inputs.flatMap((input) => [...input.actions]),
        sourceSequences: inputs.map((input) => input.sequence),
        sources: inputs.map((input) => ({
          inputEpoch: input.inputEpoch,
          sequence: input.sequence,
          actionCount: input.actions.length
        }))
      }];
    });
  }

  #validatedControl(control: MatchReplayControl): MatchReplayControl {
    if (!this.#playerIds.includes(control.playerId)) {
      throw new RangeError("Control player is not in this match.");
    }
    if (control.kind === "resetInput") {
      if (!validCounter(control.inputEpoch)) {
        throw new TypeError("Invalid reset input epoch.");
      }
      return {
        kind: "resetInput",
        playerId: control.playerId,
        inputEpoch: control.inputEpoch
      };
    }
    if (control.kind !== "clearHeld") {
      throw new TypeError("Unknown replay control.");
    }
    return { kind: "clearHeld", playerId: control.playerId };
  }

  #validateFinish(result: MatchReplayFinalize): void {
    validateFrame(result.serverFrame);
    if (result.serverFrame < Math.max(
      this.#lastAppliedFrame,
      this.#lastRecordedFrame
    )) {
      throw new RangeError("Replay end frame is behind the action log.");
    }
    if (
      result.winnerPlayerId !== null
      && !this.#playerIds.includes(result.winnerPlayerId)
    ) {
      throw new RangeError("Replay winner is not in this match.");
    }
    if (!END_REASONS.has(result.reason)) {
      throw new TypeError("Invalid replay end reason.");
    }
    if (!verifyMatchPieceSequenceReveal(
      this.#pieceCommitment,
      result.randomSeedReveal.pieceSequence
    )) {
      throw new Error("Piece-sequence reveal does not match its commitment.");
    }
    if (!verifyMatchRandomSeedReveal(
      this.#matchRandomCommitment,
      {
        matchId: this.#matchId,
        rulesetVersion: this.#rulesetVersion,
        seeds: result.randomSeedReveal.matchRandom
      }
    )) {
      throw new Error("Match-random reveal does not match its commitment.");
    }
    if (result.finalStateHashes !== undefined) {
      result.finalStateHashes.forEach((entry, index) => {
        if (
          entry.playerId !== this.#playerIds[index]
          || !HASH_PATTERN.test(entry.hash)
        ) {
          throw new TypeError("Invalid final replay state hashes.");
        }
      });
    }
  }

  #assertOpen(): void {
    if (this.#phase !== "open") {
      throw new Error("Match replay recorder is finalizing.");
    }
  }
}

function replayJson(value: unknown): ReplayJsonValue {
  assertReplayJsonValue(value);
  return value;
}

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateFrame(serverFrame: number): void {
  if (!validCounter(serverFrame)) {
    throw new RangeError("Invalid replay server frame.");
  }
}

function validateText(value: string, name: string): void {
  if (
    value.length < 1
    || value.length > 128
    || value.includes("\0")
  ) {
    throw new TypeError(`Invalid replay ${name}.`);
  }
}

function validateOptions(options: MatchReplayRecorderOptions): void {
  [
    ["serverVersion", options.serverVersion],
    ["rulesetVersion", options.rulesetVersion],
    ["rotationSystemVersion", options.rotationSystemVersion],
    ["pieceSequenceVersion", options.pieceSequenceVersion]
  ].forEach(([name, value]) =>
    validateText(value!, name!)
  );
  if (
    !(
      typeof options.protocolVersion === "string"
      || (
        typeof options.protocolVersion === "number"
        && validCounter(options.protocolVersion)
      )
    )
  ) {
    throw new TypeError("Invalid replay protocolVersion.");
  }
  if (typeof options.protocolVersion === "string") {
    validateText(options.protocolVersion, "protocolVersion");
  }
  if (
    !Number.isSafeInteger(options.createdAtMs)
    || options.createdAtMs < 0
    || !Number.isSafeInteger(options.tickHz)
    || options.tickHz < 1
    || !validCounter(options.garbageTravelFrames)
  ) {
    throw new TypeError("Invalid replay timing options.");
  }
  const [first, second] = options.players;
  validateText(first.playerId, "first playerId");
  validateText(second.playerId, "second playerId");
  validateText(first.displayName, "first displayName");
  validateText(second.displayName, "second displayName");
  if (first.playerId === second.playerId) {
    throw new TypeError("Replay players must be distinct.");
  }
  if (
    !HASH_PATTERN.test(options.randomSeedCommitment.pieceSequence)
    || !HASH_PATTERN.test(options.randomSeedCommitment.matchRandom)
  ) {
    throw new TypeError("Replay seed commitments must be SHA-256 hashes.");
  }
}
