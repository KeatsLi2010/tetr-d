import type { RoomEffect, RoomState } from "../../../../packages/room-core/src/model.ts";
import type { MatchServerMessage, ServerMessage } from "../../../../packages/protocol/src/messages.ts";
import type { SessionStore } from "../auth/sessionStore.ts";
import type { ConnectionHub } from "../gateway/connectionHub.ts";
import type { MatchRegistry } from "../matches/matchRegistry.ts";
import type { MatchPieceSequence } from "../matchPieceSequence.ts";
import type { RoomEffectDelivery } from "./roomCommitOutbox.ts";
import { projectRoomState } from "./roomView.ts";

export interface RoomEffectProgress {
  readonly completedActions: Set<string>;
}

export interface RoomEffectActionsOptions {
  readonly sessions: SessionStore;
  readonly connections: ConnectionHub;
  readonly getRoomState: (roomId: string) => RoomState | null;
  readonly removeRoom: (
    roomId: string,
    deliveryId: string
  ) => boolean | void | Promise<boolean | void>;
  readonly matches: MatchRegistry;
  readonly report: (
    error: unknown,
    delivery: RoomEffectDelivery | null
  ) => void;
}

export class RoomEffectActions {
  readonly #sessions: SessionStore;
  readonly #connections: ConnectionHub;
  readonly #getRoomState: RoomEffectActionsOptions["getRoomState"];
  readonly #removeRoom: RoomEffectActionsOptions["removeRoom"];
  readonly #matches: MatchRegistry;
  readonly #report: RoomEffectActionsOptions["report"];

  constructor(options: RoomEffectActionsOptions) {
    this.#sessions = options.sessions;
    this.#connections = options.connections;
    this.#getRoomState = options.getRoomState;
    this.#removeRoom = options.removeRoom;
    this.#matches = options.matches;
    this.#report = options.report;
  }

  get matchCount(): number {
    return this.#matches.matchCount;
  }

  getMatchPieceSequence(matchId: string): MatchPieceSequence | null {
    return this.#matches.getMatchPieceSequence(matchId);
  }

  pruneRoomMatches(roomId: string, activeMatchId: string | null): void {
    this.#matches.pruneRoom(roomId, activeMatchId);
  }

  replayMatchStartForPlayer(playerId: string): boolean {
    const session = this.#sessions.getByPlayerId(playerId);
    if (session === null || session.roomId === null) return false;
    const state = this.#getRoomState(session.roomId);
    if (
      state === null ||
      state.activeMatch === null ||
      state.members[playerId] === undefined
    ) {
      return false;
    }
    return this.#matches.resumePlayer(playerId);
  }

  dispose(): void {
    // MatchRegistry has a wider server lifetime and is disposed by ServerApp.
  }

  sendRoomState(roomId: string): void {
    const state = this.#getRoomState(roomId);
    if (state === null || state.phase === "closed") return;
    for (const playerId of Object.keys(state.members)) {
      try {
        this.#sendPlayer(playerId, {
          type: "room.state",
          state: projectRoomState(state, playerId)
        });
      } catch (error) {
        this.#report(error, null);
      }
    }
  }

  sendCountdown(
    state: RoomState,
    effect: Extract<RoomEffect, { readonly type: "countdown.schedule" }>,
    progress: RoomEffectProgress
  ): void {
    if (
      state.countdown === null ||
      state.series === null ||
      state.countdown.countdownId !== effect.countdownId
    ) {
      throw new Error("Countdown effect does not match its room commit.");
    }
    const message: MatchServerMessage = {
      type: "match.countdown",
      roomId: state.roomId,
      countdownId: effect.countdownId,
      seriesId: state.series.seriesId,
      gameNumber: state.countdown.gameNumber,
      startsAtServerTime: effect.startsAtMs
    };
    this.#sendMembersOnce(state, message, progress);
  }

  startMatch(
    state: RoomState,
    effect: Extract<RoomEffect, { readonly type: "match.start" }>,
    progress: RoomEffectProgress
  ): void {
    const latestState = this.#getRoomState(state.roomId);
    if (latestState?.activeMatch?.matchId !== effect.matchId) return;
    const first = state.members[effect.participants[0]]?.player;
    const second = state.members[effect.participants[1]]?.player;
    if (first === undefined || second === undefined) {
      throw new Error("Match participant is missing.");
    }
    const match = this.#matches.start({
      matchId: effect.matchId,
      roomId: state.roomId,
      participants: effect.participants,
      players: [first, second]
    });
    for (const playerId of Object.keys(state.members)) {
      this.#sendOnce(
        progress,
        `start:${playerId}`,
        playerId,
        match.startMessage(playerId)
      );
    }
  }

  clearMatchInput(
    state: RoomState,
    effect: Extract<RoomEffect, { readonly type: "match.clear_input" }>
  ): void {
    if (state.activeMatch === null) return;
    this.#matches.clearHeldInput(state.activeMatch.matchId, effect.playerId);
  }

  finishDisconnectedMatch(
    effect: Extract<RoomEffect, { readonly type: "match.disconnect_forfeit" }>
  ): void {
    this.#matches.forceFinish(
      effect.matchId,
      effect.loserPlayerId,
      "disconnect_timeout"
    );
  }

  sendDisconnectedPresence(
    state: RoomState,
    effect: Extract<RoomEffect, { readonly type: "member.reconnect_deadline" }>,
    progress: RoomEffectProgress
  ): void {
    if (state.activeMatch === null) return;
    const message: MatchServerMessage = {
      type: "match.presence",
      matchId: state.activeMatch.matchId,
      playerId: effect.playerId,
      connected: false,
      graceDeadlineServerTime: effect.deadlineMs
    };
    this.#sendMembersOnce(state, message, progress);
  }

  removeMember(
    delivery: RoomEffectDelivery,
    before: RoomState,
    playerId: string,
    reason: "kicked" | "reconnect_timeout",
    progress: RoomEffectProgress
  ): void {
    if (before.members[playerId] === undefined) return;
    this.#sendOnce(progress, "removed", playerId, {
      type: "room.removed",
      roomId: delivery.roomId,
      reason
    });
    this.#clearMemberOnce(progress, playerId, delivery.roomId);
  }

  async closeRoom(
    delivery: RoomEffectDelivery,
    before: RoomState,
    reason: Extract<RoomEffect, { readonly type: "room.closed" }>["reason"],
    progress: RoomEffectProgress
  ): Promise<void> {
    for (const playerId of Object.keys(before.members)) {
      this.#sendOnce(progress, `closed:${playerId}`, playerId, {
        type: "room.closed",
        roomId: delivery.roomId,
        reason
      });
      this.#clearMemberOnce(progress, playerId, delivery.roomId);
    }
    if (progress.completedActions.has("room-removed")) return;
    await this.#removeRoom(delivery.roomId, delivery.deliveryId);
    progress.completedActions.add("room-removed");
    this.#matches.pruneRoom(delivery.roomId, null);
  }

  #sendMembersOnce(
    state: RoomState,
    message: ServerMessage,
    progress: RoomEffectProgress
  ): void {
    for (const playerId of Object.keys(state.members)) {
      this.#sendOnce(progress, `send:${playerId}`, playerId, message);
    }
  }

  #sendOnce(
    progress: RoomEffectProgress,
    action: string,
    playerId: string,
    message: ServerMessage
  ): void {
    if (progress.completedActions.has(action)) return;
    try {
      if (this.#sendPlayer(playerId, message)) {
        progress.completedActions.add(action);
      }
    } catch (error) {
      this.#report(error, null);
    }
  }

  #sendPlayer(playerId: string, message: ServerMessage): boolean {
    const session = this.#sessions.getByPlayerId(playerId);
    if (session === null || session.activeConnectionId === null) return false;
    return this.#connections.send(
      {
        sessionId: session.sessionId,
        connectionId: session.activeConnectionId,
        connectionGeneration: session.connectionGeneration
      },
      JSON.stringify(message)
    ).status === "accepted";
  }

  #clearMemberOnce(
    progress: RoomEffectProgress,
    playerId: string,
    roomId: string
  ): void {
    const action = `clear:${playerId}`;
    if (progress.completedActions.has(action)) return;
    const session = this.#sessions.getByPlayerId(playerId);
    if (session !== null) {
      this.#sessions.clearRoom(session.sessionId, roomId);
      if (session.activeConnectionId !== null) {
        this.#connections.setRoom(
          {
            sessionId: session.sessionId,
            connectionId: session.activeConnectionId,
            connectionGeneration: session.connectionGeneration
          },
          null
        );
      }
    }
    progress.completedActions.add(action);
  }
}
