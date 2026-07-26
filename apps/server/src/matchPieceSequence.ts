import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  createSharedSevenBag,
  readSharedSevenBagWindow
} from "../../../packages/game-core/src/sevenBag.ts";
import type {
  PieceKind
} from "../../../packages/game-core/src/types.ts";
import type {
  SevenBagSeed,
  SharedSevenBagState
} from "../../../packages/game-core/src/sevenBag.ts";

const COMMITMENT_DOMAIN = "tetr-d/match-piece-sequence/v1";
const SEED_BYTE_LENGTH = 16;

export const MAX_PIECE_WINDOW = 14;

export interface MatchPieceSequenceOptions {
  readonly matchId: string;
  readonly rulesetVersion: string;
  readonly playerIds: readonly [string, string];
  /** Injectable only so deterministic server tests and replays can reconstruct a match. */
  readonly seed?: SevenBagSeed;
}

export interface MatchPieceWindow {
  readonly playerId: string;
  readonly cursor: number;
  readonly pieces: readonly PieceKind[];
}

export interface MatchPieceSequenceView {
  readonly commitment: string;
  readonly cursors: Readonly<Record<string, number>>;
  readonly finished: boolean;
}

export interface MatchPieceSequenceReveal {
  readonly version: 1;
  readonly matchId: string;
  readonly rulesetVersion: string;
  readonly seedHex: string;
}

function validateContext(value: string, name: string): void {
  if (value.length < 1 || value.length > 128 || value.includes("\0")) {
    throw new TypeError(`Invalid ${name}.`);
  }
}

function cloneAndValidateSeed(seed: SevenBagSeed): SevenBagSeed {
  // createSharedSevenBag owns the canonical seed validation.
  const state = createSharedSevenBag(seed);
  return state.randomState;
}

function createRandomSeed(): SevenBagSeed {
  while (true) {
    const bytes = randomBytes(SEED_BYTE_LENGTH);
    const seed = [
      bytes.readUInt32LE(0),
      bytes.readUInt32LE(4),
      bytes.readUInt32LE(8),
      bytes.readUInt32LE(12)
    ] as const;
    if (seed.some((value) => value !== 0)) return seed;
  }
}

function seedToBytes(seed: SevenBagSeed): Buffer {
  const bytes = Buffer.allocUnsafe(SEED_BYTE_LENGTH);
  seed.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
  return bytes;
}

function seedFromHex(seedHex: string): SevenBagSeed | null {
  if (!/^[0-9a-f]{32}$/.test(seedHex)) return null;
  const bytes = Buffer.from(seedHex, "hex");
  const seed = [
    bytes.readUInt32LE(0),
    bytes.readUInt32LE(4),
    bytes.readUInt32LE(8),
    bytes.readUInt32LE(12)
  ] as const;
  return seed.every((value) => value === 0) ? null : seed;
}

function commitmentFor(
  matchId: string,
  rulesetVersion: string,
  seed: SevenBagSeed
): string {
  return createHash("sha256")
    .update(COMMITMENT_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(matchId, "utf8")
    .update("\0", "utf8")
    .update(rulesetVersion, "utf8")
    .update("\0", "utf8")
    .update(seedToBytes(seed))
    .digest("hex");
}

function equalCommitments(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function verifyMatchPieceSequenceReveal(
  commitment: string,
  reveal: MatchPieceSequenceReveal
): boolean {
  if (
    reveal.version !== 1 ||
    typeof reveal.matchId !== "string" ||
    typeof reveal.rulesetVersion !== "string" ||
    typeof reveal.seedHex !== "string"
  ) {
    return false;
  }
  const seed = seedFromHex(reveal.seedHex);
  if (seed === null) return false;
  return equalCommitments(
    commitment,
    commitmentFor(reveal.matchId, reveal.rulesetVersion, seed)
  );
}

export class MatchPieceSequence {
  readonly #matchId: string;
  readonly #rulesetVersion: string;
  readonly #playerIds: readonly [string, string];
  readonly #seed: SevenBagSeed;
  readonly #cursors = new Map<string, number>();
  #shared: SharedSevenBagState;
  #finished = false;

  readonly commitment: string;

  constructor(options: MatchPieceSequenceOptions) {
    validateContext(options.matchId, "matchId");
    validateContext(options.rulesetVersion, "rulesetVersion");
    const [firstPlayerId, secondPlayerId] = options.playerIds;
    validateContext(firstPlayerId, "playerId");
    validateContext(secondPlayerId, "playerId");
    if (firstPlayerId === secondPlayerId) {
      throw new TypeError("Match players must be distinct.");
    }

    this.#matchId = options.matchId;
    this.#rulesetVersion = options.rulesetVersion;
    this.#playerIds = Object.freeze([...options.playerIds]) as readonly [
      string,
      string
    ];
    this.#seed = cloneAndValidateSeed(options.seed ?? createRandomSeed());
    this.#shared = createSharedSevenBag(this.#seed);
    this.#cursors.set(firstPlayerId, 0);
    this.#cursors.set(secondPlayerId, 0);
    this.commitment = commitmentFor(
      this.#matchId,
      this.#rulesetVersion,
      this.#seed
    );
  }

  get view(): MatchPieceSequenceView {
    return Object.freeze({
      commitment: this.commitment,
      cursors: Object.freeze(
        Object.fromEntries(
          this.#playerIds.map((playerId) => [
            playerId,
            this.#cursors.get(playerId)!
          ])
        )
      ),
      finished: this.#finished
    });
  }

  getCursor(playerId: string): number {
    return this.#cursorFor(playerId);
  }

  peek(playerId: string, count: number): MatchPieceWindow {
    this.#assertActive();
    this.#validateCount(count);
    return this.#read(playerId, this.#cursorFor(playerId), count);
  }

  draw(playerId: string, count = 1): MatchPieceWindow {
    this.#assertActive();
    this.#validateCount(count);
    const cursor = this.#cursorFor(playerId);
    const window = this.#read(playerId, cursor, count);
    this.#cursors.set(playerId, cursor + count);
    return window;
  }

  finish(): MatchPieceSequenceReveal {
    this.#finished = true;
    return Object.freeze({
      version: 1,
      matchId: this.#matchId,
      rulesetVersion: this.#rulesetVersion,
      seedHex: seedToBytes(this.#seed).toString("hex")
    });
  }

  #read(playerId: string, cursor: number, count: number): MatchPieceWindow {
    const result = readSharedSevenBagWindow(this.#shared, cursor, count);
    this.#shared = result.state;
    return Object.freeze({
      playerId,
      cursor,
      pieces: result.pieces
    });
  }

  #cursorFor(playerId: string): number {
    const cursor = this.#cursors.get(playerId);
    if (cursor === undefined) throw new RangeError("Player is not in this match.");
    return cursor;
  }

  #assertActive(): void {
    if (this.#finished) throw new Error("Match piece sequence is finished.");
  }

  #validateCount(count: number): void {
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > MAX_PIECE_WINDOW
    ) {
      throw new RangeError("Invalid piece window size.");
    }
  }
}
