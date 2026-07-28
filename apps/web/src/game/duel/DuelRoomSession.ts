import type {
  ClientMessage,
  InputAcknowledgement,
  MatchFeedbackState,
  MatchServerMessage,
  ServerMessage
} from "@tetr-d/protocol";

import type { PlayerConfig } from "../../config/v3/index.ts";
import { DuelMatchInput } from "./DuelMatchInput.ts";
import { DuelRoomCommands } from "./DuelRoomCommands.ts";
import { INITIAL_DUEL_ROOM_VIEW } from "./initialDuelRoomView.ts";
import { MatchDeltaReceiver } from "./MatchDeltaReceiver.ts";
import { DuelTransport } from "./DuelTransport.ts";
import { DuelPenaltyDetector } from "./duelPenaltyDetector.ts";
import { DuelFeedbackPublisher, initialDuelFeedback, mergeDuelFeedback } from "./DuelFeedbackPublisher.ts";
import type { DgLabPenaltyEvent } from "../../dglab/dglabTypes.ts";
import type {
  DuelRoomView,
  EnterRoomInput
} from "./duelTypes.ts";
import {
  applyPredictedActions,
  networkPlayerState,
  predictPlayerActions
} from "./networkPlayerState.ts";

export type DuelRoomUpdateSource =
  | "control"
  | "local-prediction"
  | "realtime-snapshot";
type Listener = (
  view: DuelRoomView,
  source: DuelRoomUpdateSource
) => void;
type MatchSnapshot = Extract<
  MatchServerMessage,
  { readonly type: "match.snapshot" }
>;

export class DuelRoomSession {
  readonly #config: PlayerConfig;
  readonly #listeners = new Set<Listener>();
  readonly #scheduledInputs = new Map<number, number>();
  readonly #commands: DuelRoomCommands;
  readonly #transport: DuelTransport;
  #view: DuelRoomView = INITIAL_DUEL_ROOM_VIEW;
  #input: DuelMatchInput | null = null;
  #requestOrdinal = 0;
  readonly #matchState = new MatchDeltaReceiver();
  readonly #penaltyDetector = new DuelPenaltyDetector();
  readonly #onPenaltyEvent: ((event: DgLabPenaltyEvent) => void) | undefined;
  #lastSelfCursor: number | null = null;
  readonly #feedbackPublisher: DuelFeedbackPublisher;

  constructor(config: PlayerConfig, onPenaltyEvent?: (event: DgLabPenaltyEvent) => void) {
    this.#config = config;
    this.#onPenaltyEvent = onPenaltyEvent;
    this.#feedbackPublisher = new DuelFeedbackPublisher(() => this.#view.match?.matchId, (message) => this.#send(message));
    this.#commands = new DuelRoomCommands({
      getView: () => this.#view,
      send: (message) => this.#send(message)
    });
    this.#transport = new DuelTransport({
      onMessage: (message) => this.#handleMessage(message),
      onAuth: (auth) => this.#setView({
        player: auth.player,
        error: null
      }),
      onStatus: (connection) => {
        if (connection === "disconnected") {
          this.#input?.dispose();
          this.#input = null;
          this.#commands.reset();
        }
        this.#setView({ connection });
      }
    });
  }
  get view(): DuelRoomView {
    return this.#view;
  }
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#view, "control");
    return () => this.#listeners.delete(listener);
  }
  async resumeSaved(): Promise<boolean> {
    if (!this.#transport.hasSavedSession()) return false;
    this.#setView({ connection: "connecting", error: null });
    const resumed = await this.#transport.resumeSaved();
    if (!resumed) {
      const retrying = this.#transport.hasSavedSession();
      this.#setView({
        connection: retrying ? "disconnected" : "entry",
        error: retrying
          ? "连接暂时中断，正在保留会话并自动重试。"
          : "上次房间会话已过期，请重新进入。"
      });
    }
    return resumed;
  }
  async createRoom(input: EnterRoomInput): Promise<void> {
    await this.#enter(input, null, input.roomCode?.trim().toUpperCase() || undefined);
  }
  async joinRoom(input: EnterRoomInput): Promise<void> {
    const roomCode = input.roomCode?.trim().toUpperCase() ?? "";
    if (roomCode.length === 0) throw new Error("请输入房间码。");
    await this.#enter(input, roomCode);
  }
  setReady(ready: boolean): void {
    this.#commands.setReady(ready);
  }
  updateSettings(
    patch: Parameters<DuelRoomCommands["updateSettings"]>[0]
  ): void {
    this.#commands.updateSettings(patch);
  }
  nextRound(): void {
    const room = this.#view.room;
    if (
      room?.activeMatch === null &&
      this.#view.result === null &&
      this.#view.match !== null
    ) {
      this.#input?.dispose();
      this.#input = null;
      this.#setView({
        match: null,
        players: Object.freeze([]),
        frameAnchor: null,
        feedback: Object.freeze({})
      });
    }
    this.#commands.nextRound();
  }
  forfeit(): void {
    this.#commands.forfeit();
  }
  setLocalFeedback(feedback: MatchFeedbackState): void { this.#feedbackPublisher.update(feedback); }
  leave(): void {
    const room = this.#view.room;
    if (room !== null && room.phase !== "playing") {
      this.#send({
        type: "room.leave",
        requestId: this.#requestId("leave"),
        roomId: room.roomId,
        expectedRevision: room.revision
      });
    }
    this.#input?.dispose();
    this.#input = null;
    this.#transport.close(true);
    this.#view = INITIAL_DUEL_ROOM_VIEW;
    this.#emit("control");
  }

  dispose(): void {
    this.#feedbackPublisher.dispose();
    this.#input?.dispose();
    this.#transport.dispose();
    this.#listeners.clear();
  }

  async #enter(input: EnterRoomInput, roomCode: string | null, requestedRoomCode?: string): Promise<void> {
    const displayName = input.displayName.trim();
    if (displayName.length === 0) throw new Error("请输入昵称。");
    this.#setView({ connection: "connecting", error: null });
    await this.#transport.connectGuest(displayName);
    if (roomCode === null) {
      this.#send({
        type: "room.create",
        requestId: this.#requestId("create"),
        ...(requestedRoomCode === undefined ? {} : { roomCode: requestedRoomCode })
      });
      return;
    }
    this.#send({
      type: "room.join",
      requestId: this.#requestId("join"),
      roomCode,
      participation: "player",
      preferredSeat: 1
    });
  }

  #handleMessage(message: ServerMessage): void {
    if (message.type === "auth.ok") {
      this.#setView({ player: message.player, error: null });
      return;
    }
    if (message.type === "room.command.ok") {
      this.#commands.handleCommandOk(message);
      return;
    }
    if (message.type === "room.state") {
      this.#setView({ room: message.state, connection: "connected" });
      this.#commands.handleRoomState(message.state.revision);
      return;
    }
    if (message.type === "match.start") {
      this.#startMatch(message);
      return;
    }
    if (message.type === "match.snapshot") {
      const snapshot = this.#matchState.acceptSnapshot(message);
      if (snapshot !== null) this.#acceptSnapshot(snapshot, []);
      return;
    }
    if (message.type === "match.delta") {
      const update = this.#matchState.acceptDelta(message);
      if (update.snapshot !== null) {
        this.#acceptSnapshot(update.snapshot, message.events);
      } else if (update.resyncRequest !== null) {
        this.#send(update.resyncRequest);
      }
      return;
    }
    if (message.type === "match.inputAck") {
      this.#acceptAcknowledgement(message);
      return;
    }
    if (message.type === "match.feedback") {
      if (message.matchId !== this.#view.match?.matchId) return;
      this.#setView({ feedback: mergeDuelFeedback(this.#view.feedback, message.playerId, message.feedback) });
      return;
    }
    if (message.type === "match.end") {
      if (message.matchId !== this.#view.match?.matchId) return;
      this.#commands.reset();
      this.#input?.dispose();
      this.#input = null;
      if (message.winnerPlayerId !== null && message.winnerPlayerId !== this.#view.player?.playerId) this.#onPenaltyEvent?.({ kind: "defeat", amount: 1, source: "duel" });
      this.#setView({ result: message, feedback: Object.freeze({}) });
      return;
    }
    if (message.type === "room.removed" || message.type === "room.closed") {
      this.#input?.dispose();
      this.#input = null;
      this.#commands.reset();
      this.#transport.close(true);
      this.#view = INITIAL_DUEL_ROOM_VIEW;
      this.#emit("control");
      return;
    }
    if (message.type === "error") {
      if (this.#commands.handleError(message)) return;
      this.#setView({ error: `${message.code}: ${message.message}` });
    }
  }

  #startMatch(message: Extract<
    MatchServerMessage,
    { readonly type: "match.start" }
  >): void {
    this.#input?.dispose();
    this.#input = null;
    this.#commands.reset();
    this.#scheduledInputs.clear();
    this.#matchState.start(message.matchId);
    this.#penaltyDetector.reset();
    this.#lastSelfCursor = null;
    this.#setView({
      match: message,
      players: Object.freeze([]),
      feedback: initialDuelFeedback(message.players),
      result: null,
      frameAnchor: {
        serverFrame: message.serverFrame,
        receivedAtMs: performance.now()
      },
      error: null
    });
    this.#feedbackPublisher.start();
    if (message.inputEpoch === null) return;
    this.#input = new DuelMatchInput({
      config: this.#config,
      matchId: message.matchId,
      inputEpoch: message.inputEpoch,
      serverFrame: message.serverFrame,
      simulationHz: message.simulationHz,
      send: (input) => this.#send(input),
      predict: (actions) => this.#predict(actions),
      onForfeit: () => this.forfeit()
    });
  }

  #acceptSnapshot(message: MatchSnapshot, events: readonly import("@tetr-d/protocol").MatchEvent[]): void {
    this.#input?.synchronizeServerFrame(message.serverFrame);
    if (message.acknowledgement !== undefined) {
      this.#acceptAcknowledgement({
        matchId: message.matchId,
        acknowledgement: message.acknowledgement
      });
    }
    for (const [sequence, frame] of this.#scheduledInputs) {
      if (frame > message.serverFrame) continue;
      this.#input?.acknowledge(sequence);
      this.#scheduledInputs.delete(sequence);
    }
    const ownId = this.#view.player?.playerId;
    const displayedCursor = this.#view.players.find(
      (player) => player.playerId === ownId
    )?.pieceCursor ?? null;
    const players = message.players.map((player) =>
      networkPlayerState(
        player,
        player.playerId === ownId ? message.self : null
      )
    );
    this.#penaltyDetector.observe(players, ownId ?? null, events, (event) => this.#onPenaltyEvent?.(event));
    const ownIndex = players.findIndex((player) => player.playerId === ownId);
    if (ownIndex >= 0 && this.#input !== null) {
      let predicted = players[ownIndex]!;
      for (const pending of this.#input.pending) {
        predicted = applyPredictedActions(predicted, pending.actions);
      }
      players[ownIndex] = predicted;
      const cursor = message.self?.pieceCursor ?? null;
      if (
        cursor !== null &&
        this.#lastSelfCursor !== null &&
        cursor > this.#lastSelfCursor &&
        (displayedCursor === null || displayedCursor < cursor)
      ) this.#input.notifyPieceSpawned("automatic");
      this.#lastSelfCursor = cursor;
    }
    this.#setView({
      players: Object.freeze(players),
      frameAnchor: {
        serverFrame: message.serverFrame,
        receivedAtMs: performance.now()
      }
    }, "realtime-snapshot");
  }

  #acceptAcknowledgement(message: {
    readonly matchId: string;
    readonly acknowledgement: InputAcknowledgement;
  }): void {
    if (message.matchId !== this.#view.match?.matchId) return;
    for (const disposition of message.acknowledgement.dispositions) {
      if (disposition.status === "scheduled") {
        this.#scheduledInputs.set(
          disposition.sequence,
          disposition.serverFrame
        );
      } else {
        this.#input?.acknowledge(disposition.sequence);
      }
    }
  }

  #predict(actions: Parameters<typeof applyPredictedActions>[1]) {
    const ownId = this.#view.player?.playerId;
    const index = this.#view.players.findIndex(
      (player) => player.playerId === ownId
    );
    if (index < 0) return [];
    const players = [...this.#view.players];
    const predicted = predictPlayerActions(players[index]!, actions);
    players[index] = predicted.state;
    this.#setView(
      { players: Object.freeze(players) },
      "local-prediction"
    );
    return predicted.spawnCauses;
  }

  #requestId(action: string): string {
    this.#requestOrdinal += 1;
    return `${action}-${Date.now().toString(36)}-${this.#requestOrdinal}`;
  }

  #send(message: ClientMessage): boolean {
    try {
      this.#transport.send(message);
      return true;
    } catch (error) {
      this.#setView({
        error: error instanceof Error ? error.message : "发送失败。"
      });
      return false;
    }
  }

  #setView(
    patch: Partial<DuelRoomView>,
    source: DuelRoomUpdateSource = "control"
  ): void {
    this.#view = Object.freeze({ ...this.#view, ...patch });
    this.#emit(source);
  }

  #emit(source: DuelRoomUpdateSource): void {
    for (const listener of this.#listeners) listener(this.#view, source);
  }
}
