import type {
  RoomActorPrincipal,
  RoomDispatchResult
} from "../roomActor.ts";
import type {
  SessionStore
} from "../auth/sessionStore.ts";
import type {
  RoomManager
} from "../rooms/roomManager.ts";
import { RoomRuntimeQueueCapacityError } from "../rooms/roomRuntime.ts";
import {
  retryRoomRuntimeCapacity
} from "../rooms/roomRuntimeCapacityRetry.ts";
import type {
  RoomCapacityRetryOptions,
  RoomCapacityRetryResult
} from "../rooms/roomRuntimeCapacityRetry.ts";

type ConnectionContext = Pick<
  RoomActorPrincipal,
  "sessionId" | "player" | "connectionId" | "connectionGeneration"
>;

export interface RoomConnectionDispatchRetrierOptions {
  readonly sessions: SessionStore;
  readonly rooms: RoomManager;
  readonly wait?: RoomCapacityRetryOptions<unknown>["wait"];
}

export class RoomConnectionDispatchRetrier {
  readonly #sessions: SessionStore;
  readonly #rooms: RoomManager;
  readonly #wait: RoomCapacityRetryOptions<unknown>["wait"];

  constructor(options: RoomConnectionDispatchRetrierOptions) {
    this.#sessions = options.sessions;
    this.#rooms = options.rooms;
    this.#wait = options.wait;
  }

  connectionLost(
    context: ConnectionContext,
    roomId: string
  ): Promise<RoomCapacityRetryResult<RoomDispatchResult | null>> {
    return retryRoomRuntimeCapacity({
      attempt: async () => {
        const pending = this.#rooms.connectionLost(
          roomId,
          context.player.playerId,
          context.connectionId
        );
        return pending === null ? null : await pending;
      },
      shouldContinue: () => this.#shouldMarkLost(context, roomId),
      ...(this.#wait === undefined ? {} : { wait: this.#wait })
    });
  }

  restoreConnection(
    context: ConnectionContext,
    roomId: string
  ): Promise<RoomCapacityRetryResult<RoomDispatchResult | null>> {
    return retryRoomRuntimeCapacity({
      attempt: async () => {
        const pending = this.#rooms.restoreConnection(
          roomId,
          context.player.playerId,
          context.connectionId
        );
        const result = pending === null ? null : await pending;
        if (result?.receipt.kind === "ignored") {
          // The queued snapshot changed; rebuild after bounded backoff.
          throw new RoomRuntimeQueueCapacityError();
        }
        return result;
      },
      shouldContinue: () => this.#shouldRestore(context, roomId),
      ...(this.#wait === undefined ? {} : { wait: this.#wait })
    });
  }

  #shouldMarkLost(
    context: ConnectionContext,
    roomId: string
  ): boolean {
    const session = this.#sessions.getBySessionId(context.sessionId);
    if (
      session === null ||
      session.roomId !== roomId ||
      session.connectionGeneration !== context.connectionGeneration ||
      (session.activeConnectionId !== null &&
        session.activeConnectionId !== context.connectionId)
    ) {
      return false;
    }
    const member = this.#member(context, roomId);
    return (
      member?.connection.kind === "connected" &&
      member.connection.connectionId === context.connectionId
    );
  }

  #shouldRestore(
    context: ConnectionContext,
    roomId: string
  ): boolean {
    if (
      !this.#sessions.isCurrentConnection(
        context.sessionId,
        context.connectionId,
        context.connectionGeneration
      ) ||
      this.#sessions.getBySessionId(context.sessionId)?.roomId !== roomId
    ) {
      return false;
    }
    const member = this.#member(context, roomId);
    return member !== null;
  }

  #member(context: ConnectionContext, roomId: string) {
    try {
      return this.#rooms.getById(roomId)?.state.members[
        context.player.playerId
      ] ?? null;
    } catch {
      return null;
    }
  }
}
