import {
  PlayerSimulation,
  createPlayerSimulationRules,
  type SimulationInputAction
} from "../../../../packages/game-core/src/index.ts";
import type { PieceKind } from "../../../../packages/game-core/src/types.ts";
import type {
  InputAction,
  InputAcknowledgement,
  MatchServerMessage
} from "../../../../packages/protocol/src/matchMessages.ts";
import {
  PIECE_SEQUENCE_VERSION,
  RULESET_VERSION
} from "../../../../packages/protocol/src/versions.ts";
import type { MatchPieceSequence } from "../matchPieceSequence.ts";
import {
  MatchInputQueue,
  type MatchInputEnvelope
} from "./matchInputQueue.ts";
import {
  createMatchRandomSeeds,
  MatchRandomStream
} from "./matchRandom.ts";
import type {
  MatchCoordinatorOptions,
  MatchCoordinatorView,
  MatchFinishedResult,
  MatchInputReceipt
} from "./matchCoordinatorTypes.ts";
import {
  SequencePieceSource,
  mapDisposition,
  netPacketLists
} from "./matchCoordinatorHelpers.ts";
import { selfStateHash } from "./matchProjection.ts";

export class MatchCoordinator {
  readonly #matchId: string;
  readonly #roomId: string;
  readonly #participants: readonly [string, string];
  readonly #players: MatchCoordinatorOptions["players"];
  readonly #sequence: MatchPieceSequence;
  readonly #tickRateHz: number;
  readonly #snapshotRateHz: number;
  readonly #inputQueue: MatchInputQueue;
  readonly #simulations: readonly [PlayerSimulation, PlayerSimulation];
  readonly #startWindow: readonly PieceKind[];
  readonly #holeRandom: MatchRandomStream;
  readonly #onSnapshot: (coordinator: MatchCoordinatorView) => void;
  readonly #onFinished: (result: MatchFinishedResult) => void;
  readonly #onError: (error: unknown) => void;
  #serverFrame = 0;
  #stateSequence = 0;
  #eventSequence = 0;
  #snapshotAccumulator = 0;
  #finished = false;

  constructor(options: MatchCoordinatorOptions) {
    this.#validate(options);
    this.#matchId = options.matchId;
    this.#roomId = options.roomId;
    this.#participants = Object.freeze([...options.participants]) as readonly [string, string];
    this.#players = Object.freeze([...options.players]) as MatchCoordinatorOptions["players"];
    this.#sequence = options.sequence;
    this.#tickRateHz = options.tickRateHz;
    this.#snapshotRateHz = options.snapshotRateHz ?? 30;
    this.#onSnapshot = options.onSnapshot ?? (() => undefined);
    this.#onFinished = options.onFinished ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
    this.#startWindow = Object.freeze([
      ...this.#sequence.peek(this.#participants[0], 14).pieces
    ]);
    const seeds = options.randomSeeds ?? createMatchRandomSeeds();
    const attackRandom = [
      new MatchRandomStream(seeds.firstAttack),
      new MatchRandomStream(seeds.secondAttack)
    ] as const;
    this.#holeRandom = new MatchRandomStream(seeds.garbageHole);
    const rules = createPlayerSimulationRules(this.#tickRateHz);
    this.#simulations = this.#participants.map((playerId, index) =>
      new PlayerSimulation({
        playerId,
        rules,
        pieces: new SequencePieceSource(this.#sequence, playerId),
        nextAttackRoundingRoll: () => attackRandom[index]!.nextFloat(),
        ...(options.initialBoards === undefined
          ? {}
          : { initialBoard: options.initialBoards[index]! })
      })
    ) as unknown as readonly [PlayerSimulation, PlayerSimulation];
    this.#inputQueue = new MatchInputQueue(this.#participants, {
      maxClientFrameLag: this.#tickRateHz * 2,
      maxClientFrameLead: this.#tickRateHz
    });
  }

  get view(): MatchCoordinatorView {
    return Object.freeze({
      matchId: this.#matchId,
      roomId: this.#roomId,
      participants: this.#participants,
      players: this.#players,
      tickRateHz: this.#tickRateHz,
      serverFrame: this.#serverFrame,
      stateSequence: this.#stateSequence,
      lastEventSequence: this.#eventSequence,
      finished: this.#finished,
      simulations: this.#simulations
    });
  }

  get sequence(): MatchPieceSequence { return this.#sequence; }

  startMessage(
    viewerPlayerId: string
  ): Extract<MatchServerMessage, { readonly type: "match.start" }> {
    const isPlayer = this.#participants.includes(viewerPlayerId);
    return {
      type: "match.start",
      matchId: this.#matchId,
      pieceSequenceVersion: PIECE_SEQUENCE_VERSION,
      pieceSequenceCommitment: this.#sequence.commitment,
      selfPieceCursor: isPlayer ? 0 : null,
      selfPieceWindow: isPlayer ? this.#startWindow : [],
      rulesetVersion: RULESET_VERSION,
      simulationHz: this.#tickRateHz,
      garbageTravelFrames:
        this.#simulations[0].view.rules.garbageTravelFrames,
      inputEpoch: isPlayer
        ? this.#inputQueue.viewPlayer(viewerPlayerId).inputEpoch
        : null,
      serverFrame: this.#serverFrame,
      players: this.#players
    };
  }

  enqueueInput(input: Omit<MatchInputEnvelope, "playerId"> & {
    readonly playerId: string;
    readonly actions: readonly InputAction[];
  }): MatchInputReceipt {
    const disposition = this.#inputQueue.enqueue(input, this.#serverFrame);
    const state = this.#inputQueue.viewPlayer(input.playerId);
    const acknowledgement: InputAcknowledgement = {
      inputEpoch: state.inputEpoch,
      receivedThroughSequence: Math.max(0, state.nextSequence - 1),
      settledThroughSequence:
        disposition.status === "applied"
          ? disposition.sequence
          : Math.max(0, disposition.sequence - 1),
      dispositions: Object.freeze([mapDisposition(disposition)])
    };
    return Object.freeze({
      serverFrame: this.#serverFrame,
      selfStateHash: selfStateHash(this.view, input.playerId),
      acknowledgement
    });
  }

  clearHeldInput(playerId: string): void {
    this.#simulationFor(playerId).clearHeldInput();
  }

  resetInput(playerId: string): { readonly inputEpoch: number; readonly nextSequence: 0 } {
    this.#simulationFor(playerId).clearHeldInput();
    return this.#inputQueue.resetPlayer(playerId);
  }

  advanceOneFrame(): void {
    if (this.#finished) return;
    this.#serverFrame += 1;
    const actions = new Map<string, SimulationInputAction[]>();
    for (const input of this.#inputQueue.drain(this.#serverFrame)) {
      const list = actions.get(input.playerId) ?? [];
      list.push(...input.actions);
      actions.set(input.playerId, list);
    }
    const results = this.#simulations.map((simulation) =>
      simulation.advanceFrame(
        this.#serverFrame,
        actions.get(simulation.view.playerId) ?? []
      )
    );
    const [firstPackets, secondPackets] = netPacketLists(
      results[0]!.outgoingAttacks,
      results[1]!.outgoingAttacks
    );
    this.#queuePackets(0, firstPackets);
    this.#queuePackets(1, secondPackets);
    if (results[0]!.toppedOut || results[1]!.toppedOut) {
      if (results[0]!.toppedOut && results[1]!.toppedOut) {
        this.#finish(null, "simultaneous_topout");
      } else {
        this.#finish(
          results[0]!.toppedOut ? this.#participants[1] : this.#participants[0],
          "topout"
        );
      }
      return;
    }
    this.#snapshotAccumulator += this.#snapshotRateHz;
    if (this.#snapshotAccumulator >= this.#tickRateHz) {
      this.#snapshotAccumulator -= this.#tickRateHz;
      this.#stateSequence += 1;
      this.#safeSnapshot();
    }
  }

  forceFinish(
    loserPlayerId: string,
    reason: "forfeit" | "disconnect_timeout"
  ): boolean {
    if (this.#finished) return false;
    const loserIndex = this.#participants.indexOf(loserPlayerId);
    if (loserIndex < 0) throw new RangeError("Loser is not in this match.");
    this.#finish(this.#participants[loserIndex === 0 ? 1 : 0], reason);
    return true;
  }

  forceDraw(): boolean {
    if (this.#finished) return false;
    this.#finish(null, "draw");
    return true;
  }

  close(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#sequence.finish();
  }

  #queuePackets(sourceIndex: 0 | 1, packets: readonly number[]): void {
    const targetIndex = sourceIndex === 0 ? 1 : 0;
    for (const amount of packets) {
      this.#eventSequence += 1;
      this.#simulations[targetIndex].queueGarbage({
        packetId: `${this.#matchId}:g:${this.#eventSequence}`,
        sourcePlayerId: this.#participants[sourceIndex],
        amount,
        appliesAtFrame:
          this.#serverFrame +
          this.#simulations[targetIndex].view.rules.garbageTravelFrames,
        hole: this.#holeRandom.nextInteger(10)
      });
    }
  }

  #finish(
    winnerPlayerId: string | null,
    reason: MatchFinishedResult["reason"]
  ): void {
    if (this.#finished) return;
    this.#finished = true;
    const reveal = this.#sequence.finish();
    const message: MatchFinishedResult["message"] = {
      type: "match.end",
      matchId: this.#matchId,
      serverFrame: this.#serverFrame,
      winnerPlayerId,
      reason,
      pieceSequenceReveal: {
        version: 1,
        matchId: reveal.matchId,
        rulesetVersion: RULESET_VERSION,
        seedHex: reveal.seedHex
      }
    };
    try {
      this.#onFinished(Object.freeze({
        roomId: this.#roomId,
        matchId: this.#matchId,
        serverFrame: this.#serverFrame,
        winnerPlayerId,
        reason,
        message
      }));
    } catch (error) {
      this.#report(error);
    }
  }

  #safeSnapshot(): void {
    try { this.#onSnapshot(this.view); }
    catch (error) { this.#report(error); }
  }

  #simulationFor(playerId: string): PlayerSimulation {
    const simulation = this.#simulations.find(
      (candidate) => candidate.view.playerId === playerId
    );
    if (simulation === undefined) throw new RangeError("Player is not in match.");
    return simulation;
  }

  #validate(options: MatchCoordinatorOptions): void {
    if (
      options.matchId.length === 0 ||
      options.roomId.length === 0 ||
      options.participants[0] === options.participants[1] ||
      options.players[0].playerId !== options.participants[0] ||
      options.players[1].playerId !== options.participants[1] ||
      !Number.isSafeInteger(options.tickRateHz) ||
      options.tickRateHz < 60 ||
      options.tickRateHz > 1_000
    ) {
      throw new TypeError("Invalid match coordinator options.");
    }
    const snapshotRate = options.snapshotRateHz ?? 30;
    if (
      !Number.isSafeInteger(snapshotRate) ||
      snapshotRate < 1 ||
      snapshotRate > 60 ||
      snapshotRate > options.tickRateHz
    ) {
      throw new TypeError("Invalid match snapshot rate.");
    }
  }

  #report(error: unknown): void {
    try { this.#onError(error); } catch { /* terminal reporting boundary */ }
  }
}
