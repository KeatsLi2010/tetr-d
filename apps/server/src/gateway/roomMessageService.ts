import type {
  ProtocolErrorCode,
  RoomClientMessage,
  ServerMessage
} from "../../../../packages/protocol/src/messages.ts";
import type { RoomDispatchResult } from "../roomActor.ts";
import type { GuestSession, SessionStore } from "../auth/sessionStore.ts";
import type { ConnectionHub } from "./connectionHub.ts";
import { RoomCreateReceiptLedger } from "./roomCreateReceiptLedger.ts";
import { RoomConnectionDispatchRetrier } from "./roomConnectionDispatchRetrier.ts";
import { RoomMembershipCoordinator } from "./roomMembershipCoordinator.ts";
import { RoomMutationHandler } from "./roomMutationHandler.ts";
import type { AuthenticatedConnection } from "./realtimeService.ts";
import type { RoomManager } from "../rooms/roomManager.ts";
import { RoomRuntimeQueueCapacityError } from "../rooms/roomRuntime.ts";
import { projectRoomState } from "../rooms/roomView.ts";

export interface RoomMessageServiceOptions {
  readonly sessions: SessionStore;
  readonly connections: ConnectionHub;
  readonly rooms: RoomManager;
  readonly createReceipts?: RoomCreateReceiptLedger;
  readonly connectionDispatchRetrier?: RoomConnectionDispatchRetrier;
  readonly onError?: (error: unknown) => void;
}

export class RoomMessageService {
  readonly #sessions: SessionStore;
  readonly #connections: ConnectionHub;
  readonly #rooms: RoomManager;
  readonly #createReceipts: RoomCreateReceiptLedger;
  readonly #membership: RoomMembershipCoordinator;
  readonly #mutations: RoomMutationHandler;
  readonly #onError: (error: unknown) => void;

  constructor(options: RoomMessageServiceOptions) {
    this.#sessions = options.sessions;
    this.#connections = options.connections;
    this.#rooms = options.rooms;
    this.#createReceipts =
      options.createReceipts ?? new RoomCreateReceiptLedger();
    this.#onError = options.onError ?? (() => undefined);
    const connectionDispatchRetrier =
      options.connectionDispatchRetrier ??
      new RoomConnectionDispatchRetrier({
        sessions: options.sessions,
        rooms: options.rooms
      });
    this.#membership = new RoomMembershipCoordinator({
      sessions: options.sessions,
      connections: options.connections,
      rooms: options.rooms,
      connectionDispatchRetrier,
      report: (error) => this.#report(error)
    });
    this.#mutations = new RoomMutationHandler({
      rooms: options.rooms,
      currentSession: (context) => this.#currentSession(context),
      principal: (context) => this.#principal(context),
      leaveSessionRoom: (context, roomId) =>
        this.leaveSessionRoom(context, roomId),
      sendRoomState: (context, roomId) =>
        this.sendRoomState(context, roomId),
      sendCommandOk: (context, requestId, roomId, revision, replayed) =>
        this.#sendCommandOk(
          context,
          requestId,
          roomId,
          revision,
          replayed
        ),
      sendError: (
        context,
        code,
        message,
        retryable,
        requestId,
        currentRevision
      ) => this.#sendError(
        context,
        code,
        message,
        retryable,
        requestId,
        currentRevision
      ),
      send: (context, message) => this.#send(context, message)
    });
  }

  async handle(
    context: AuthenticatedConnection,
    message: RoomClientMessage
  ): Promise<void> {
    if (message.type === "room.create") {
      this.#handleCreate(context, message);
      return;
    }
    if (message.type === "room.join") {
      await this.#handleJoin(context, message);
      return;
    }
    await this.#mutations.handle(context, message);
  }

  sendRoomState(context: AuthenticatedConnection, roomId: string): void {
    const room = this.#rooms.getById(roomId);
    if (
      room === null ||
      room.state.phase === "closed" ||
      room.state.members[context.player.playerId] === undefined
    ) {
      return;
    }
    this.#send(context, {
      type: "room.state",
      state: projectRoomState(room.state, context.player.playerId)
    });
  }

  leaveSessionRoom(context: AuthenticatedConnection, roomId: string): void {
    this.#membership.releaseJoinReservation(context, roomId);
  }

  #handleCreate(
    context: AuthenticatedConnection,
    message: Extract<RoomClientMessage, { readonly type: "room.create" }>
  ): void {
    const session = this.#currentSession(context);
    if (session === null) return;
    const key = {
      sessionId: context.sessionId,
      requestId: message.requestId,
      ...(message.settings === undefined ? {} : { settings: message.settings })
    };
    let createdRoomId: string | null = null;
    let committed = false;
    try {
      const prior = this.#createReceipts.lookup(key);
      if (prior.kind === "replay") {
        this.#sendCommandOk(
          context,
          message.requestId,
          prior.receipt.roomId,
          prior.receipt.revision,
          true
        );
        this.sendRoomState(context, prior.receipt.roomId);
        return;
      }
      if (prior.kind === "request_id_reused") {
        this.#sendError(
          context,
          "REQUEST_ID_REUSED",
          "Request ID was already used with another payload.",
          false,
          message.requestId
        );
        return;
      }
      if (session.roomId !== null) {
        this.#sendError(
          context,
          "ALREADY_IN_ROOM",
          "Already in a room.",
          false,
          message.requestId
        );
        return;
      }
      const room = this.#rooms.create({
        principal: this.#principal(context),
        ...(message.settings === undefined ? {} : { settings: message.settings })
      });
      createdRoomId = room.roomId;
      if (!this.#sessions.bindRoom(context.sessionId, room.roomId)) {
        throw new Error("Session room reservation failed.");
      }
      const bound = this.#connections.setRoom(context, room.roomId);
      if (bound.status !== "updated" && bound.status !== "no_change") {
        throw new Error(`Connection room binding failed: ${bound.status}.`);
      }
      this.#createReceipts.record(key, {
        roomId: room.roomId,
        revision: room.state.revision
      });
      committed = true;
      this.#sendCommandOk(
        context,
        message.requestId,
        room.roomId,
        room.state.revision,
        false
      );
      this.sendRoomState(context, room.roomId);
    } catch (error) {
      if (!committed && createdRoomId !== null) {
        this.#membership.rollbackCreatedRoom(context, createdRoomId);
      }
      this.#report(error);
      if (!committed) {
        this.#sendError(
          context,
          "MESSAGE_INVALID",
          "Room creation failed.",
          true,
          message.requestId
        );
      }
    }
  }

  async #handleJoin(
    context: AuthenticatedConnection,
    message: Extract<RoomClientMessage, { readonly type: "room.join" }>
  ): Promise<void> {
    const session = this.#currentSession(context);
    if (session === null) return;
    const room = this.#rooms.getByCode(message.roomCode);
    if (room === null) {
      this.#sendError(context, "ROOM_NOT_FOUND", "Room not found.", false, message.requestId);
      return;
    }
    if (session.roomId !== null && session.roomId !== room.roomId) {
      this.#sendError(context, "ALREADY_IN_ROOM", "Already in another room.", false, message.requestId);
      return;
    }
    const reservedNow = session.roomId === null;
    if (!this.#sessions.bindRoom(context.sessionId, room.roomId)) {
      this.#sendError(context, "ALREADY_IN_ROOM", "Already in another room.", false, message.requestId);
      return;
    }
    let joined: RoomDispatchResult | null;
    try {
      joined = await this.#rooms.joinByCode(
        this.#principal(context),
        room.roomCode,
        {
          type: "member.join",
          requestId: message.requestId,
          participation: message.participation,
          ...(message.preferredSeat === undefined
            ? {}
            : { preferredSeat: message.preferredSeat })
        }
      );
    } catch (error) {
      if (reservedNow) {
        this.#membership.releaseJoinReservation(context, room.roomId);
      }
      if (error instanceof RoomRuntimeQueueCapacityError) {
        this.#sendError(
          context,
          "RATE_LIMITED",
          "Room command queue is full.",
          true,
          message.requestId
        );
        return;
      }
      this.#report(error);
      this.#sendError(
        context,
        "MESSAGE_INVALID",
        "Room join failed.",
        true,
        message.requestId
      );
      return;
    }
    if (joined === null || joined.receipt.kind !== "committed") {
      if (reservedNow) {
        this.#membership.releaseJoinReservation(context, room.roomId);
      }
      if (joined === null) {
        this.#sendError(context, "ROOM_NOT_FOUND", "Room not found.", false, message.requestId);
      } else {
        this.#mutations.sendDispatchError(context, joined, message.requestId);
      }
      return;
    }
    if (!(await this.#membership.bindCommittedJoin(context, room.roomId))) {
      return;
    }
    this.#sendCommandOk(
      context,
      message.requestId,
      room.roomId,
      joined.receipt.revision,
      joined.replayed
    );
    this.sendRoomState(context, room.roomId);
  }

  #sendCommandOk(
    context: AuthenticatedConnection,
    requestId: string,
    roomId: string,
    revision: number,
    replayed: boolean
  ): void {
    this.#send(context, {
      type: "room.command.ok",
      requestId,
      roomId,
      revision,
      replayed
    });
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

  #currentSession(context: AuthenticatedConnection): GuestSession | null {
    if (
      !this.#sessions.isCurrentConnection(
        context.sessionId,
        context.connectionId,
        context.connectionGeneration
      )
    ) {
      return null;
    }
    return this.#sessions.getBySessionId(context.sessionId);
  }

  #principal(context: AuthenticatedConnection) {
    return {
      sessionId: context.sessionId,
      player: context.player,
      connectionId: context.connectionId,
      connectionGeneration: context.connectionGeneration
    };
  }

  #report(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Logging is a terminal boundary.
    }
  }
}
