import type { RoomState } from "../../../../packages/room-core/src/model.ts";
import type { MatchClientMessage, MatchServerMessage } from "../../../../packages/protocol/src/matchMessages.ts";
import type { PublicPlayer } from "../../../../packages/protocol/src/roomMessages.ts";
import { RULESET_VERSION } from "../../../../packages/protocol/src/versions.ts";
import type { SessionStore } from "../auth/sessionStore.ts";
import type { ConnectionHub } from "../gateway/connectionHub.ts";
import { MatchPieceSequence } from "../matchPieceSequence.ts";
import { FixedStepLoop } from "./fixedStepLoop.ts";
import type { FixedStepClock, FixedStepScheduler, FixedStepOverloadEvent, FixedStepLoopState } from "./fixedStepLoop.ts";
import { MatchCoordinator } from "./matchCoordinator.ts";
import type { MatchFinishedResult, MatchInputReceipt } from "./matchCoordinatorTypes.ts";
import { projectMatchUpdate } from "./matchDeltaProjection.ts";
import { MatchDeliveryBaselines } from "./matchDeliveryBaselines.ts";
import { projectMatchSnapshot } from "./matchProjection.ts";
import { MatchReplayPersistence } from "./matchReplayPersistence.ts";
import { MatchFeedbackRegistry } from "./matchFeedbackRegistry.ts";

export interface StartRegisteredMatch {
  readonly matchId: string;
  readonly roomId: string;
  readonly participants: readonly [string, string];
  readonly players: readonly [PublicPlayer, PublicPlayer];
}

export interface MatchRegistryOptions {
  readonly sessions: SessionStore;
  readonly connections: ConnectionHub;
  readonly tickRateHz: number;
  readonly snapshotRateHz?: number;
  readonly getRoomState: (roomId: string) => RoomState | null;
  readonly onMatchFinished: (result: MatchFinishedResult) => void | Promise<void>;
  readonly sequenceFactory?: (input: StartRegisteredMatch) => MatchPieceSequence;
  readonly clock?: FixedStepClock;
  readonly scheduler?: FixedStepScheduler;
  readonly onOverload?: (event: FixedStepOverloadEvent) => void;
  readonly onError?: (error: unknown) => void;
  readonly replayRootDirectory?: string;
  readonly serverVersion?: string;
  readonly now?: () => number;
}

function sameMatch(coordinator: MatchCoordinator, input: StartRegisteredMatch): boolean {
  const view = coordinator.view;
  return view.roomId === input.roomId && view.participants[0] === input.participants[0] && view.participants[1] === input.participants[1];
}

export class MatchRegistry {
  readonly #sessions: SessionStore;
  readonly #connections: ConnectionHub;
  readonly #tickRateHz: number;
  readonly #snapshotRateHz: number;
  readonly #getRoomState: MatchRegistryOptions["getRoomState"];
  readonly #onMatchFinished: MatchRegistryOptions["onMatchFinished"];
  readonly #sequenceFactory: NonNullable<MatchRegistryOptions["sequenceFactory"]>;
  readonly #onError: (error: unknown) => void;
  readonly #matches = new Map<string, MatchCoordinator>();
  readonly #inputGenerations = new Map<string, Map<string, number>>();
  readonly feedback = new MatchFeedbackRegistry();
  readonly #delivery = new MatchDeliveryBaselines();
  readonly #loop: FixedStepLoop;
  readonly #replays: MatchReplayPersistence;
  #disposed = false;

  constructor(options: MatchRegistryOptions) {
    this.#sessions = options.sessions;
    this.#connections = options.connections;
    this.#tickRateHz = options.tickRateHz;
    this.#snapshotRateHz = options.snapshotRateHz ?? 30;
    this.#getRoomState = options.getRoomState;
    this.#onMatchFinished = options.onMatchFinished;
    this.#onError = options.onError ?? (() => undefined);
    this.#replays = new MatchReplayPersistence({
      serverVersion: options.serverVersion ?? "dev", tickRateHz: this.#tickRateHz,
      ...(options.replayRootDirectory === undefined ? {} : { rootDirectory: options.replayRootDirectory }),
      ...(options.now === undefined ? {} : { now: options.now }), onError: (error) => this.#report(error)
    });
    this.#sequenceFactory = options.sequenceFactory ?? ((input) =>
      new MatchPieceSequence({
        matchId: input.matchId,
        rulesetVersion: RULESET_VERSION,
        playerIds: input.participants
      })
    );
    this.#loop = new FixedStepLoop({
      tickRateHz: this.#tickRateHz,
      maxCatchUpSteps: 8,
      step: () => this.#stepMatches(),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      ...(options.onOverload === undefined
        ? {}
        : { onOverloadChange: options.onOverload }),
      onStepError: () => "stop",
      onError: (error) => this.#report(error)
    });
  }

  get matchCount(): number { return this.#matches.size; }
  get loopState(): FixedStepLoopState { return this.#loop.state; }
  get(matchId: string): MatchCoordinator | null {
    return this.#matches.get(matchId) ?? null;
  }

  getMatchPieceSequence(matchId: string): MatchPieceSequence | null {
    return this.#matches.get(matchId)?.sequence ?? null;
  }

  start(input: StartRegisteredMatch): MatchCoordinator {
    this.#assertActive();
    const existing = this.#matches.get(input.matchId);
    if (existing !== undefined) {
      if (!sameMatch(existing, input)) {
        throw new Error(`Conflicting match ID: ${input.matchId}`);
      }
      return existing;
    }
    const sequence = this.#sequenceFactory(input);
    const coordinator = new MatchCoordinator({
      ...input,
      sequence,
      tickRateHz: this.#tickRateHz,
      snapshotRateHz: this.#snapshotRateHz,
      onSnapshot: (view) => this.#broadcastSnapshot(view.matchId),
      onFinished: (result) => this.#handleFinished(result),
      onAppliedFrame: (frame) => this.#replays.recordAppliedFrame(input.matchId, frame),
      onControlFrame: (frame) => this.#replays.recordControlFrame(input.matchId, frame),
      onError: (error) => this.#report(error)
    });
    this.#matches.set(input.matchId, coordinator);
    this.feedback.start(input.matchId);
    this.#replays.start({
      matchId: input.matchId,
      players: input.players,
      sequence,
      randomSeeds: coordinator.view.randomSeeds,
      garbageTravelFrames: coordinator.view.simulations[0].view.rules.garbageTravelFrames
    });
    this.#rememberInputGenerations(input);
    if (this.#loop.state === "idle") this.#loop.start();
    else if (this.#loop.state === "paused") this.#loop.resume();
    if (this.#loop.state !== "running") {
      this.#matches.delete(input.matchId);
      this.#inputGenerations.delete(input.matchId);
      this.feedback.delete(input.matchId);
      coordinator.close();
      void this.#replays.closePartial(input.matchId);
      throw new Error("Match simulation loop is unavailable.");
    }
    return coordinator;
  }

  pruneRoom(roomId: string, activeMatchId: string | null): void {
    for (const [matchId, coordinator] of this.#matches) {
      if (coordinator.view.roomId !== roomId || matchId === activeMatchId) continue;
      coordinator.close();
      void this.#replays.closePartial(matchId);
      this.#matches.delete(matchId);
      this.#inputGenerations.delete(matchId);
      this.#delivery.clearMatch(matchId);
      this.feedback.delete(matchId);
    }
    if (this.#matches.size === 0 && this.#loop.state === "running") {
      this.#loop.pause();
    }
  }

  resumePlayer(playerId: string): boolean {
    const match = this.#matchForPlayer(playerId);
    if (match === null) return false;
    if (match.view.participants.includes(playerId)) {
      this.#resetInputForNewGeneration(match, playerId);
    }
    const state = this.#getRoomState(match.view.roomId);
    if (state !== null) {
      this.#broadcastRoom(state, {
        type: "match.presence",
        matchId: match.view.matchId,
        playerId,
        connected: true
      });
    }
    const started = this.#sendPlayer(playerId, match.startMessage(playerId));
    for (const message of this.feedback.snapshots(match.view.matchId, match.view.participants)) this.#sendPlayer(playerId, message);
    const snapshotted = this.sendSnapshot(playerId, match.view.matchId);
    return started || snapshotted;
  }

  receiveInput(
    playerId: string,
    message: Extract<MatchClientMessage, { readonly type: "match.input" }>
  ): MatchInputReceipt | null {
    const match = this.#matches.get(message.matchId);
    if (
      match === undefined ||
      match.view.finished ||
      !match.view.participants.includes(playerId)
    ) {
      return null;
    }
    return match.enqueueInput({
      playerId,
      inputEpoch: message.inputEpoch,
      sequence: message.sequence,
      clientFrame: message.clientFrame,
      actions: message.actions
    });
  }

  clearHeldInput(matchId: string, playerId: string): boolean {
    const match = this.#matches.get(matchId);
    if (match === undefined || !match.view.participants.includes(playerId)) {
      return false;
    }
    match.clearHeldInput(playerId);
    return true;
  }

  forceFinish(
    matchId: string,
    loserPlayerId: string,
    reason: "forfeit" | "disconnect_timeout"
  ): boolean {
    return this.#matches.get(matchId)?.forceFinish(loserPlayerId, reason) ?? false;
  }

  sendInputAck(
    playerId: string,
    matchId: string,
    receipt: MatchInputReceipt
  ): boolean {
    const sent = this.#sendPlayer(playerId, {
      type: "match.inputAck",
      matchId,
      ...receipt
    });
    if (!sent) this.#delivery.reject(matchId, playerId);
    return sent;
  }

  sendSnapshot(playerId: string, matchId: string): boolean {
    const match = this.#matches.get(matchId);
    if (match === undefined) return false;
    const snapshot = projectMatchSnapshot(match.view, playerId);
    const generation = this.#connectionGeneration(playerId);
    const sent = this.#sendPlayer(playerId, snapshot);
    if (sent && generation !== null) {
      this.#delivery.accept(matchId, playerId, generation, snapshot);
    } else {
      this.#delivery.reject(matchId, playerId);
    }
    return sent;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#loop.close();
    for (const match of this.#matches.values()) match.close();
    void this.#replays.closeAllPartials();
    this.#matches.clear();
    this.#inputGenerations.clear();
    this.feedback.clearAll();
    this.#delivery.clear();
  }

  #stepMatches(): void {
    for (const match of [...this.#matches.values()]) {
      try { match.advanceOneFrame(); }
      catch (error) {
        this.#report(error);
        try { match.forceDraw(); } catch (finishError) { this.#report(finishError); }
      }
    }
  }

  #broadcastSnapshot(matchId: string): void {
    const match = this.#matches.get(matchId);
    if (match === undefined) return;
    const state = this.#getRoomState(match.view.roomId);
    if (state === null) return;
    for (const playerId of Object.keys(state.members)) {
      const generation = this.#connectionGeneration(playerId);
      if (generation === null) {
        this.#delivery.reject(matchId, playerId);
        continue;
      }
      const baseline = this.#delivery.get(
        matchId, playerId, generation
      );
      const update = projectMatchUpdate(match.view, playerId, baseline);
      const sent = this.#sendPlayer(playerId, update.message);
      if (sent) {
        this.#delivery.accept(
          matchId, playerId, generation, update.nextBaseline
        );
      } else this.#delivery.reject(matchId, playerId);
    }
  }

  #handleFinished(result: MatchFinishedResult): void {
    const state = this.#getRoomState(result.roomId);
    if (state !== null) this.#broadcastRoom(state, result.message);
    try {
      void this.#replays.finalize(result.matchId, {
        serverFrame: result.serverFrame,
        winnerPlayerId: result.winnerPlayerId,
        reason: result.reason,
        randomSeedReveal: result.randomSeedReveal,
        finalStateHashes: result.finalStateHashes
      }).then(() => this.#onMatchFinished(result))
        .catch((error) => this.#report(error))
        .finally(() => this.#retireFinished(result.matchId));
    } catch (error) {
      this.#report(error);
      this.#retireFinished(result.matchId);
    }
  }

  #retireFinished(matchId: string): void {
    const match = this.#matches.get(matchId);
    if (match === undefined || !match.view.finished) return;
    this.#matches.delete(matchId);
    this.#inputGenerations.delete(matchId);
    this.#delivery.clearMatch(matchId);
    this.feedback.delete(matchId);
    if (this.#matches.size === 0 && this.#loop.state === "running") {
      this.#loop.pause();
    }
  }

  #matchForPlayer(playerId: string): MatchCoordinator | null {
    const session = this.#sessions.getByPlayerId(playerId);
    if (session?.roomId === null || session?.roomId === undefined) return null;
    const state = this.#getRoomState(session.roomId);
    if (state?.activeMatch === null || state?.activeMatch === undefined) return null;
    return this.#matches.get(state.activeMatch.matchId) ?? null;
  }

  #rememberInputGenerations(input: StartRegisteredMatch): void {
    const generations = new Map<string, number>();
    for (const playerId of input.participants) {
      const session = this.#sessions.getByPlayerId(playerId);
      if (session !== null) {
        generations.set(playerId, session.connectionGeneration);
      }
    }
    this.#inputGenerations.set(input.matchId, generations);
  }

  #resetInputForNewGeneration(
    match: MatchCoordinator,
    playerId: string
  ): void {
    const session = this.#sessions.getByPlayerId(playerId);
    if (session === null) return;
    const generations = this.#inputGenerations.get(match.view.matchId);
    const previous = generations?.get(playerId);
    if (previous === session.connectionGeneration) return;
    match.resetInput(playerId);
    if (generations === undefined) {
      this.#inputGenerations.set(
        match.view.matchId,
        new Map([[playerId, session.connectionGeneration]])
      );
    } else {
      generations.set(playerId, session.connectionGeneration);
    }
  }

  #broadcastRoom(state: RoomState, message: MatchServerMessage): void {
    for (const playerId of Object.keys(state.members)) {
      this.#sendPlayer(playerId, message);
    }
  }

  #connectionGeneration(playerId: string): number | null {
    const session = this.#sessions.getByPlayerId(playerId);
    return session === null || session.activeConnectionId === null
      ? null : session.connectionGeneration;
  }

  #sendPlayer(playerId: string, message: MatchServerMessage): boolean {
    const session = this.#sessions.getByPlayerId(playerId);
    if (session === null || session.activeConnectionId === null) return false;
    return this.#connections.send({
      sessionId: session.sessionId,
      connectionId: session.activeConnectionId,
      connectionGeneration: session.connectionGeneration
    }, JSON.stringify(message)).status === "accepted";
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Match registry is disposed.");
  }

  #report(error: unknown): void {
    try { this.#onError(error); } catch { /* terminal reporting boundary */ }
  }
}
