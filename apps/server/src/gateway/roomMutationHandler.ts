import type {
  ProtocolErrorCode,
  RoomClientMessage,
  ServerMessage
} from "../../../../packages/protocol/src/messages.ts";
import type { GuestSession } from "../auth/sessionStore.ts";
import type {
  RoomActorPrincipal,
  RoomDispatchResult
} from "../roomActor.ts";
import type { RoomManager } from "../rooms/roomManager.ts";
import { RoomRuntimeQueueCapacityError } from "../rooms/roomRuntime.ts";
import { mapRoomClientMessageToUserCommand } from "./roomCommandMapper.ts";
import type { AuthenticatedConnection } from "./realtimeService.ts";

export interface RoomMutationHandlerOptions {
  readonly rooms: RoomManager;
  readonly currentSession: (
    context: AuthenticatedConnection
  ) => GuestSession | null;
  readonly principal: (
    context: AuthenticatedConnection
  ) => RoomActorPrincipal;
  readonly leaveSessionRoom: (
    context: AuthenticatedConnection,
    roomId: string
  ) => void;
  readonly sendRoomState: (
    context: AuthenticatedConnection,
    roomId: string
  ) => void;
  readonly sendCommandOk: (
    context: AuthenticatedConnection,
    requestId: string,
    roomId: string,
    revision: number,
    replayed: boolean
  ) => void;
  readonly sendError: (
    context: AuthenticatedConnection,
    code: ProtocolErrorCode,
    message: string,
    retryable: boolean,
    requestId?: string,
    currentRevision?: number
  ) => void;
  readonly send: (
    context: AuthenticatedConnection,
    message: ServerMessage
  ) => void;
}

export class RoomMutationHandler {
  readonly #options: RoomMutationHandlerOptions;

  constructor(options: RoomMutationHandlerOptions) {
    this.#options = options;
  }

  async handle(
    context: AuthenticatedConnection,
    message: RoomClientMessage
  ): Promise<void> {
    const mapping = mapRoomClientMessageToUserCommand(message);
    if (mapping.kind !== "mapped") {
      this.#options.sendError(
        context,
        "MESSAGE_INVALID",
        "Unsupported room command.",
        false
      );
      return;
    }
    const session = this.#options.currentSession(context);
    if (session === null) return;
    const leaveReplay = message.type === "room.leave" && session.roomId === null;
    if (!leaveReplay && session.roomId !== mapping.roomId) {
      this.#options.sendError(
        context,
        "NOT_IN_ROOM",
        "Not in this room.",
        false,
        mapping.command.requestId
      );
      return;
    }
    const pending = this.#options.rooms.dispatchUser(
      mapping.roomId,
      this.#options.principal(context),
      mapping.command
    );
    if (pending === null) {
      this.#options.leaveSessionRoom(context, mapping.roomId);
      this.#options.sendError(
        context,
        "ROOM_NOT_FOUND",
        "Room not found.",
        false,
        mapping.command.requestId
      );
      return;
    }
    let result: RoomDispatchResult;
    try {
      result = await pending;
    } catch (error) {
      if (!(error instanceof RoomRuntimeQueueCapacityError)) throw error;
      this.#options.sendError(
        context,
        "RATE_LIMITED",
        "Room command queue is full.",
        true,
        mapping.command.requestId
      );
      return;
    }
    if (result.receipt.kind !== "committed") {
      this.sendDispatchError(context, result, mapping.command.requestId);
      return;
    }
    this.#options.sendCommandOk(
      context,
      mapping.command.requestId,
      mapping.roomId,
      result.receipt.revision,
      result.replayed
    );
    if (message.type === "room.leave") {
      this.#options.leaveSessionRoom(context, mapping.roomId);
      this.#options.send(context, {
        type: "room.removed",
        roomId: mapping.roomId,
        reason: "left"
      });
      return;
    }
    this.#options.sendRoomState(context, mapping.roomId);
  }

  sendDispatchError(
    context: AuthenticatedConnection,
    result: RoomDispatchResult,
    requestId?: string
  ): void {
    if (result.receipt.kind === "rejected") {
      this.#options.sendError(
        context,
        result.receipt.code,
        `Room command rejected: ${result.receipt.code}.`,
        result.receipt.code === "REVISION_CONFLICT",
        requestId,
        result.receipt.currentRevision
      );
      return;
    }
    this.#options.sendError(
      context,
      "MESSAGE_INVALID",
      "Stale room command ignored.",
      true,
      requestId
    );
  }
}
