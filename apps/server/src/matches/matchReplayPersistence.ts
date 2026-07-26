import {
  PIECE_SEQUENCE_VERSION,
  PROTOCOL_VERSION,
  ROTATION_SYSTEM_VERSION,
  RULESET_VERSION
} from "../../../../packages/protocol/src/versions.ts";
import type { PublicPlayer } from "../../../../packages/protocol/src/roomMessages.ts";
import type { MatchPieceSequence } from "../matchPieceSequence.ts";
import { createMatchRandomSeedCommitment } from "./matchReplayCommitment.ts";
import { MatchReplayRecorder } from "./matchReplayRecorder.ts";
import { ReplayBackpressureError } from "../replays/replayWriter.ts";
import type {
  MatchReplayAppliedFrame,
  MatchReplayControlFrame,
  MatchReplayFinalize
} from "./matchReplayRecorderTypes.ts";
import type { MatchRandomSeeds } from "./matchRandom.ts";

export interface MatchReplayPersistenceOptions {
  readonly rootDirectory?: string;
  readonly serverVersion: string;
  readonly tickRateHz: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
  readonly maxPendingOperations?: number;
}

export interface StartPersistentMatchReplay {
  readonly matchId: string;
  readonly players: readonly [PublicPlayer, PublicPlayer];
  readonly sequence: MatchPieceSequence;
  readonly randomSeeds: MatchRandomSeeds;
  readonly garbageTravelFrames: number;
}

interface ReplaySession {
  tail: Promise<MatchReplayRecorder | null>;
  ending: boolean;
  pendingOperations: number;
  completion?: Promise<void>;
}

/**
 * Keeps disk latency outside the authoritative simulation loop while
 * preserving the exact coordinator callback order for each match.
 */
export class MatchReplayPersistence {
  readonly #rootDirectory: string | undefined;
  readonly #serverVersion: string;
  readonly #tickRateHz: number;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #maxPendingOperations: number;
  readonly #sessions = new Map<string, ReplaySession>();

  constructor(options: MatchReplayPersistenceOptions) {
    this.#rootDirectory = options.rootDirectory;
    this.#serverVersion = options.serverVersion;
    this.#tickRateHz = options.tickRateHz;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => undefined);
    this.#maxPendingOperations = options.maxPendingOperations ?? 1_024;
    if (
      !Number.isSafeInteger(this.#maxPendingOperations)
      || this.#maxPendingOperations < 1
    ) {
      throw new RangeError("maxPendingOperations must be positive.");
    }
  }

  start(input: StartPersistentMatchReplay): void {
    if (this.#rootDirectory === undefined) return;
    if (this.#sessions.has(input.matchId)) {
      throw new Error(`Replay already exists for match: ${input.matchId}`);
    }
    const tail = MatchReplayRecorder.create({
      rootDirectory: this.#rootDirectory,
      matchId: input.matchId,
      createdAtMs: this.#now(),
      serverVersion: this.#serverVersion,
      protocolVersion: PROTOCOL_VERSION,
      rulesetVersion: RULESET_VERSION,
      rotationSystemVersion: ROTATION_SYSTEM_VERSION,
      pieceSequenceVersion: PIECE_SEQUENCE_VERSION,
      tickHz: this.#tickRateHz,
      garbageTravelFrames: input.garbageTravelFrames,
      players: input.players,
      randomSeedCommitment: {
        pieceSequence: input.sequence.commitment,
        matchRandom: createMatchRandomSeedCommitment({
          matchId: input.matchId,
          rulesetVersion: RULESET_VERSION,
          seeds: input.randomSeeds
        })
      }
    }).catch((error: unknown) => {
      this.#report(error);
      return null;
    });
    const session: ReplaySession = {
      tail,
      ending: false,
      pendingOperations: 1
    };
    this.#sessions.set(input.matchId, session);
    void tail.then(() => {
      session.pendingOperations = Math.max(0, session.pendingOperations - 1);
    });
  }

  recordAppliedFrame(
    matchId: string,
    frame: MatchReplayAppliedFrame
  ): void {
    if (frame.drainedInputs.length === 0) return;
    this.#append(matchId, (recorder) =>
      recorder.recordAppliedFrame(frame)
    );
  }

  recordControlFrame(
    matchId: string,
    frame: MatchReplayControlFrame
  ): void {
    this.#append(matchId, (recorder) =>
      recorder.recordControlFrame(frame)
    );
  }

  finalize(
    matchId: string,
    result: MatchReplayFinalize
  ): Promise<void> {
    const session = this.#sessions.get(matchId);
    if (session === undefined) return Promise.resolve();
    if (session.completion !== undefined) return session.completion;
    session.ending = true;
    const completion = session.tail
      .then(async (recorder) => {
        if (recorder !== null) await recorder.finalize(result);
      })
      .catch((error: unknown) => this.#report(error))
      .finally(() => {
        this.#sessions.delete(matchId);
      });
    session.completion = completion;
    return completion;
  }

  closePartial(matchId: string): Promise<void> {
    const session = this.#sessions.get(matchId);
    if (session === undefined) return Promise.resolve();
    if (session.completion !== undefined) return session.completion;
    session.ending = true;
    const completion = session.tail
      .then(async (recorder) => {
        if (recorder !== null) await recorder.closePartial();
      })
      .catch((error: unknown) => this.#report(error))
      .finally(() => {
        this.#sessions.delete(matchId);
      });
    session.completion = completion;
    return completion;
  }

  async closeAllPartials(): Promise<void> {
    await Promise.all(
      [...this.#sessions.keys()].map((matchId) =>
        this.closePartial(matchId)
      )
    );
  }

  #append(
    matchId: string,
    operation: (recorder: MatchReplayRecorder) => Promise<unknown>
  ): void {
    const session = this.#sessions.get(matchId);
    if (session === undefined || session.ending) return;
    if (session.pendingOperations >= this.#maxPendingOperations) {
      this.#report(new ReplayBackpressureError(
        session.pendingOperations,
        this.#maxPendingOperations
      ));
      void this.closePartial(matchId);
      return;
    }
    session.pendingOperations += 1;
    session.tail = session.tail.then(async (recorder) => {
      if (recorder === null) {
        session.pendingOperations -= 1;
        return null;
      }
      try {
        await operation(recorder);
        return recorder;
      } catch (error) {
        this.#report(error);
        try {
          await recorder.closePartial();
        } catch (closeError) {
          this.#report(closeError);
        }
        return null;
      } finally {
        session.pendingOperations -= 1;
      }
    });
  }

  #report(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Logging is a terminal boundary.
    }
  }
}
