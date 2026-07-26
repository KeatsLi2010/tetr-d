import type { RoomState } from "../../../../packages/room-core/src/model.ts";
import type {
  MatchClientMessage,
  ProtocolErrorCode,
  ServerMessage
} from "../../../../packages/protocol/src/messages.ts";
import type { SessionStore } from "../auth/sessionStore.ts";
import type { ConnectionHub } from "../gateway/connectionHub.ts";
import type { AuthenticatedConnection } from "../gateway/realtimeService.ts";
import type { RoomManager } from "../rooms/roomManager.ts";
import type { MatchRegistry } from "./matchRegistry.ts";

export interface MatchMessageServiceOptions {
  readonly sessions: SessionStore;
  readonly connections: ConnectionHub;
  readonly rooms: RoomManager;
  readonly matches: MatchRegistry;
}

interface ActiveMatchContext {
  readonly state: RoomState;
  readonly playerId: string;
}

export class MatchMessageService {
  readonly #sessions: SessionStore;
  readonly #connections: ConnectionHub;
  readonly #rooms: RoomManager;
  readonly #matches: MatchRegistry;

  constructor(options: MatchMessageServiceOptions) {
    this.#sessions = options.sessions;
    this.#connections = options.connections;
    this.#rooms = options.rooms;
    this.#matches = options.matches;
  }

  handle(
    context: AuthenticatedConnection,
    message: MatchClientMessage
  ): void {
    if (!this.#isCurrent(context)) return;
    switch (message.type) {
      case "match.input":
        this.#handleInput(context, message);
        return;
      case "match.resyncRequest":
        this.#handleResync(context, message);
        return;
      case "match.feedback":
        this.#handleFeedback(context, message);
        return;
      case "match.forfeit":
        this.#handleForfeit(context, message);
        return;
    }
  }

  #handleInput(
    context: AuthenticatedConnection,
    message: Extract<MatchClientMessage, { readonly type: "match.input" }>
  ): void {
    const active = this.#activeMatch(context, message.matchId, true);
    if (active === null) return;
    const receipt = this.#matches.receiveInput(active.playerId, message);
    if (receipt === null) {
      this.#sendError(
        context,
        "MATCH_NOT_ACTIVE",
        "The authoritative match is no longer accepting input.",
        false
      );
      return;
    }
    this.#matches.sendInputAck(active.playerId, message.matchId, receipt);
  }

  #handleResync(
    context: AuthenticatedConnection,
    message: Extract<
      MatchClientMessage,
      { readonly type: "match.resyncRequest" }
    >
  ): void {
    const active = this.#activeMatch(context, message.matchId, false);
    if (active === null) return;
    if (!this.#matches.sendSnapshot(active.playerId, message.matchId)) {
      this.#sendError(
        context,
        "MATCH_NOT_ACTIVE",
        "The authoritative match snapshot is unavailable.",
        true
      );
    }
  }

  #handleForfeit(
    context: AuthenticatedConnection,
    message: Extract<MatchClientMessage, { readonly type: "match.forfeit" }>
  ): void {
    const active = this.#activeMatch(
      context,
      message.matchId,
      true,
      message.roomId,
      message.requestId
    );
    if (active === null) return;
    if (active.state.revision !== message.expectedRevision) {
      this.#sendError(
        context,
        "REVISION_CONFLICT",
        "Room revision changed before the forfeit was processed.",
        true,
        message.requestId,
        active.state.revision
      );
      return;
    }
    if (!this.#matches.forceFinish(message.matchId, active.playerId, "forfeit")) {
      this.#sendError(
        context,
        "MATCH_NOT_ACTIVE",
        "The match has already finished.",
        false,
        message.requestId
      );
    }
  }

  #handleFeedback(
    context: AuthenticatedConnection,
    message: Extract<MatchClientMessage, { readonly type: "match.feedback" }>
  ): void {
    const active = this.#activeMatch(context, message.matchId, true);
    if (active === null) return;
    const match = this.#matches.get(message.matchId);
    const feedback = match === null
      ? null
      : this.#matches.feedback.receive(
        active.playerId,
        message,
        match.view.participants
      );
    if (feedback === null) return;
    const outbound: ServerMessage = {
      type: "match.feedback",
      matchId: message.matchId,
      playerId: active.playerId,
      feedback
    };
    for (const memberId of Object.keys(active.state.members)) this.#sendPlayer(memberId, outbound);
  }

  clearFeedback(playerId: string): void {
    const session = this.#sessions.getByPlayerId(playerId);
    if (session?.roomId === null || session?.roomId === undefined) return;
    const room = this.#rooms.getById(session.roomId);
    const matchId = room?.state.activeMatch?.matchId;
    if (room === null || room === undefined || matchId === undefined) return;
    const match = this.#matches.get(matchId);
    const feedback = match === null ? null : this.#matches.feedback.clear(playerId, matchId);
    if (feedback === null) return;
    const outbound: ServerMessage = {
      type: "match.feedback",
      matchId,
      playerId,
      feedback
    };
    for (const memberId of Object.keys(room.state.members)) this.#sendPlayer(memberId, outbound);
  }

  #activeMatch(
    context: AuthenticatedConnection,
    matchId: string,
    requireParticipant: boolean,
    expectedRoomId?: string,
    requestId?: string
  ): ActiveMatchContext | null {
    const session = this.#sessions.getBySessionId(context.sessionId);
    if (session === null || session.roomId === null) {
      this.#sendError(
        context,
        "NOT_IN_ROOM",
        "Join a room before sending match messages.",
        false,
        requestId
      );
      return null;
    }
    if (expectedRoomId !== undefined && expectedRoomId !== session.roomId) {
      this.#sendError(
        context,
        "NOT_IN_ROOM",
        "The requested match is not in the current room.",
        false,
        requestId
      );
      return null;
    }
    const room = this.#rooms.getById(session.roomId);
    if (room === null) {
      this.#sendError(
        context,
        "ROOM_NOT_FOUND",
        "The current room no longer exists.",
        false,
        requestId
      );
      return null;
    }
    const playerId = context.player.playerId;
    if (room.state.members[playerId] === undefined) {
      this.#sendError(
        context,
        "NOT_IN_ROOM",
        "The player is not a member of this room.",
        false,
        requestId
      );
      return null;
    }
    if (room.state.activeMatch?.matchId !== matchId) {
      this.#sendError(
        context,
        "MATCH_NOT_ACTIVE",
        "No active room match matches this message.",
        false,
        requestId
      );
      return null;
    }
    if (
      requireParticipant &&
      !room.state.activeMatch.participants.includes(playerId)
    ) {
      this.#sendError(
        context,
        "NOT_SEATED",
        "Spectators cannot control or forfeit a match.",
        false,
        requestId
      );
      return null;
    }
    return { state: room.state, playerId };
  }

  #isCurrent(context: AuthenticatedConnection): boolean {
    return this.#sessions.isCurrentConnection(
      context.sessionId,
      context.connectionId,
      context.connectionGeneration
    );
  }

  #sendError(
    context: AuthenticatedConnection,
    code: ProtocolErrorCode,
    message: string,
    retryable: boolean,
    requestId?: string,
    currentRevision?: number
  ): void {
    this.#send(context, {
      type: "error",
      code,
      message,
      retryable,
      ...(requestId === undefined ? {} : { requestId }),
      ...(currentRevision === undefined ? {} : { currentRevision })
    });
  }

  #send(context: AuthenticatedConnection, message: ServerMessage): void {
    this.#connections.send(context, JSON.stringify(message));
  }

  #sendPlayer(playerId: string, message: ServerMessage): void {
    const session = this.#sessions.getByPlayerId(playerId);
    if (session === null || session.activeConnectionId === null) return;
    this.#connections.send({
      sessionId: session.sessionId,
      connectionId: session.activeConnectionId,
      connectionGeneration: session.connectionGeneration
    }, JSON.stringify(message));
  }
}
