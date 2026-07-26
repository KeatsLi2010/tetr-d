import type { SevenBagSeed } from "../../../../packages/game-core/src/sevenBag.ts";
import type { InputAction } from "../../../../packages/protocol/src/matchMessages.ts";
import {
  PIECE_SEQUENCE_VERSION,
  PROTOCOL_VERSION,
  ROTATION_SYSTEM_VERSION,
  RULESET_VERSION
} from "../../../../packages/protocol/src/versions.ts";
import type { ReplayJsonObject } from "../replays/replayTypes.ts";
import type {
  MatchReplayControl,
  MatchReplayEndReason
} from "./matchReplayRecorderTypes.ts";
import type { MatchRandomSeeds } from "./matchRandom.ts";

export interface ParsedReplayMetadata {
  readonly protocolVersion: string | number;
  readonly rulesetVersion: string;
  readonly pieceSequenceVersion: string;
  readonly rotationSystemVersion: string;
  readonly tickHz: number;
  readonly garbageTravelFrames: number;
  readonly players: readonly [
    { readonly playerId: string; readonly displayName: string },
    { readonly playerId: string; readonly displayName: string }
  ];
  readonly pieceCommitment: string;
  readonly matchRandomCommitment: string;
}

interface ParsedReplaySource {
  readonly inputEpoch: number;
  readonly sequence: number;
  readonly actionCount: number;
}

export interface ParsedAppliedPlayer {
  readonly playerId: string;
  readonly actions: readonly InputAction[];
  readonly sourceSequences: readonly number[];
  readonly sources: readonly ParsedReplaySource[];
}

export interface ParsedReplayEnd {
  readonly winnerPlayerId: string | null;
  readonly reason: MatchReplayEndReason;
  readonly pieceSeedHex: string;
  readonly randomSeeds: MatchRandomSeeds;
  readonly finalStateHashes?: readonly {
    readonly playerId: string;
    readonly hash: string;
  }[];
}

export function parseReplayMetadata(
  value: ReplayJsonObject | undefined
): ParsedReplayMetadata {
  const metadata = replayObject(value, "replay metadata");
  const protocolVersion = metadata.protocolVersion;
  if (
    !(
      typeof protocolVersion === "string"
      || (typeof protocolVersion === "number" && Number.isSafeInteger(protocolVersion))
    )
  ) throw new Error("Invalid replay protocol version.");
  if (
    protocolVersion !== PROTOCOL_VERSION
    || metadata.rulesetVersion !== RULESET_VERSION
    || metadata.pieceSequenceVersion !== PIECE_SEQUENCE_VERSION
    || metadata.rotationSystemVersion !== ROTATION_SYSTEM_VERSION
  ) {
    throw new Error("Replay engine version is unsupported.");
  }
  const players = replayArray(metadata.players, "replay players");
  if (players.length !== 2) throw new Error("Replay must have two players.");
  const parsedPlayers = players.map((value) => {
    const player = replayObject(value, "replay player");
    return {
      playerId: text(player.playerId, "playerId"),
      displayName: text(player.displayName, "displayName")
    };
  }) as [
    { playerId: string; displayName: string },
    { playerId: string; displayName: string }
  ];
  const commitments = replayObject(
    metadata.randomSeedCommitment,
    "seed commitments"
  );
  return {
    protocolVersion,
    rulesetVersion: text(metadata.rulesetVersion, "rulesetVersion"),
    pieceSequenceVersion: metadata.pieceSequenceVersion as string,
    rotationSystemVersion: metadata.rotationSystemVersion,
    tickHz: counter(metadata.tickHz, "tickHz", 1),
    garbageTravelFrames: counter(
      metadata.garbageTravelFrames,
      "garbageTravelFrames"
    ),
    players: parsedPlayers,
    pieceCommitment: hash(
      commitments.pieceSequence,
      "piece commitment"
    ),
    matchRandomCommitment: hash(
      commitments.matchRandom,
      "match random commitment"
    )
  };
}

export function parseAppliedPlayer(value: unknown): ParsedAppliedPlayer {
  const player = replayObject(value, "applied player");
  const actions = replayArray(player.actions, "applied actions")
    .map(parseAction);
  const sourceSequences = replayArray(
    player.sourceSequences,
    "source sequences"
  ).map((value) => counter(value, "source sequence"));
  const sources = replayArray(player.sources, "input sources")
    .map((sourceValue) => {
      const source = replayObject(sourceValue, "input source");
      return {
        inputEpoch: counter(source.inputEpoch, "inputEpoch"),
        sequence: counter(source.sequence, "sequence"),
        actionCount: counter(source.actionCount, "actionCount", 1)
      };
    });
  return {
    playerId: text(player.playerId, "playerId"),
    actions,
    sourceSequences,
    sources
  };
}

export function parseReplayControl(value: unknown): MatchReplayControl {
  const control = replayObject(value, "replay control");
  const playerId = text(control.playerId, "control playerId");
  if (control.kind === "clearHeld") return { kind: "clearHeld", playerId };
  if (control.kind === "resetInput") {
    return {
      kind: "resetInput",
      playerId,
      inputEpoch: counter(control.inputEpoch, "inputEpoch")
    };
  }
  throw new Error("Unknown replay control.");
}

export function parseReplayEnd(value: unknown): ParsedReplayEnd {
  const end = replayObject(value, "replay end");
  if (end.type !== "matchEnd") throw new Error("Invalid replay end type.");
  const reveal = replayObject(end.randomSeedReveal, "random seed reveal");
  const reason = text(end.reason, "end reason") as MatchReplayEndReason;
  const validReasons: readonly string[] = [
    "topout", "forfeit", "disconnect_timeout",
    "simultaneous_topout", "draw"
  ];
  if (!validReasons.includes(reason)) throw new Error("Invalid end reason.");
  const winner = end.winnerPlayerId;
  if (winner !== null && typeof winner !== "string") {
    throw new Error("Invalid replay winner.");
  }
  const hashes = end.finalStateHashes === undefined
    ? undefined
    : replayArray(end.finalStateHashes, "final hashes").map((value) => {
      const entry = replayObject(value, "final hash");
      return {
        playerId: text(entry.playerId, "hash playerId"),
        hash: hash(entry.hash, "final state hash")
      };
    });
  return {
    winnerPlayerId: winner,
    reason,
    pieceSeedHex: seedHex(reveal.pieceSequenceSeedHex),
    randomSeeds: {
      firstAttack: uint32(reveal.firstAttack, "firstAttack"),
      secondAttack: uint32(reveal.secondAttack, "secondAttack"),
      garbageHole: uint32(reveal.garbageHole, "garbageHole")
    },
    ...(hashes === undefined ? {} : { finalStateHashes: hashes })
  };
}

export function parsePieceSeed(seed: string): SevenBagSeed {
  const bytes = Buffer.from(seedHex(seed), "hex");
  return [
    bytes.readUInt32LE(0),
    bytes.readUInt32LE(4),
    bytes.readUInt32LE(8),
    bytes.readUInt32LE(12)
  ];
}

export function replayObject(
  value: unknown,
  name: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${name}.`);
  }
  return value as Record<string, unknown>;
}

export function replayArray(
  value: unknown,
  name: string
): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

function parseAction(value: unknown): InputAction {
  const action = replayObject(value, "input action");
  const direction = action.direction;
  switch (action.kind) {
    case "move":
      if (
        (direction === "left" || direction === "right")
        && typeof action.pressed === "boolean"
      ) return action as unknown as InputAction;
      break;
    case "moveStep":
    case "moveToWall":
      if (direction === "left" || direction === "right") {
        return action as unknown as InputAction;
      }
      break;
    case "softDrop":
      if (typeof action.pressed === "boolean") {
        return action as unknown as InputAction;
      }
      break;
    case "softDropStep":
      if (counter(action.cells, "soft drop cells", 1) > 0) {
        return action as unknown as InputAction;
      }
      break;
    case "rotate":
      if (direction === "cw" || direction === "ccw" || direction === "180") {
        return action as unknown as InputAction;
      }
      break;
    case "sonicDrop":
    case "clearHeld":
    case "hardDrop":
    case "hold":
      return action as unknown as InputAction;
  }
  throw new Error("Invalid replay input action.");
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function counter(value: unknown, name: string, minimum = 0): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
  ) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function uint32(value: unknown, name: string): number {
  const result = counter(value, name, 1);
  if (result > 0xffff_ffff) throw new Error(`Invalid ${name}.`);
  return result;
}

function hash(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`Invalid ${name}.`);
  return result;
}

function seedHex(value: unknown): string {
  const result = text(value, "piece sequence seed");
  if (!/^[a-f0-9]{32}$/.test(result)) {
    throw new Error("Invalid piece sequence seed.");
  }
  return result;
}
