import type { SessionStore } from "../auth/sessionStore.ts";
import type { RoomManager } from "../rooms/roomManager.ts";
import type {
  ConnectionHub,
  ConnectionIdentity
} from "./connectionHub.ts";
import type { AuthenticatedConnection } from "./realtimeService.ts";
import type {
  RoomConnectionDispatchRetrier
} from "./roomConnectionDispatchRetrier.ts";

export interface RoomMembershipCoordinatorOptions {
  readonly sessions: SessionStore;
  readonly connections: ConnectionHub;
  readonly rooms: RoomManager;
  readonly connectionDispatchRetrier: RoomConnectionDispatchRetrier;
  readonly report: (error: unknown) => void;
}

function roomBindingSucceeded(status: string): boolean {
  return status === "updated" || status === "no_change";
}

export class RoomMembershipCoordinator {
  readonly #sessions: SessionStore;
  readonly #connections: ConnectionHub;
  readonly #rooms: RoomManager;
  readonly #connectionDispatchRetrier: RoomConnectionDispatchRetrier;
  readonly #report: (error: unknown) => void;

  constructor(options: RoomMembershipCoordinatorOptions) {
    this.#sessions = options.sessions;
    this.#connections = options.connections;
    this.#rooms = options.rooms;
    this.#connectionDispatchRetrier =
      options.connectionDispatchRetrier;
    this.#report = options.report;
  }

  rollbackCreatedRoom(
    context: AuthenticatedConnection,
    roomId: string
  ): void {
    const operations = [
      () => this.#connections.setRoom(context, null),
      () => this.#sessions.clearRoom(context.sessionId, roomId),
      () => this.#rooms.remove(roomId)
    ];
    for (const operation of operations) {
      try {
        operation();
      } catch (error) {
        this.#safeReport(error);
      }
    }
  }

  releaseJoinReservation(
    context: AuthenticatedConnection,
    roomId: string
  ): void {
    const session = this.#sessions.getBySessionId(context.sessionId);
    if (!this.#sessions.clearRoom(context.sessionId, roomId)) return;
    if (session === null || session.activeConnectionId === null) return;
    try {
      this.#connections.setRoom(
        this.#identityFor(session, session.activeConnectionId),
        null
      );
    } catch (error) {
      this.#safeReport(error);
    }
  }

  async bindCommittedJoin(
    context: AuthenticatedConnection,
    roomId: string
  ): Promise<boolean> {
    try {
      if (roomBindingSucceeded(
        this.#connections.setRoom(context, roomId).status
      )) {
        return true;
      }
    } catch (error) {
      this.#safeReport(error);
    }

    const session = this.#sessions.getBySessionId(context.sessionId);
    if (session?.roomId === roomId && session.activeConnectionId !== null) {
      const current = this.#identityFor(session, session.activeConnectionId);
      if (this.#connections.isCurrent(current)) {
        try {
          const rebound = this.#connections.setRoom(current, roomId);
          if (roomBindingSucceeded(rebound.status)) {
            if (current.connectionId === context.connectionId) return true;
            const restored =
              await this.#connectionDispatchRetrier.restoreConnection(
                { ...current, player: context.player },
                roomId
              );
            if (
              restored.status === "stopped" ||
              restored.value === null ||
              restored.value.receipt.kind === "committed"
            ) {
              return false;
            }
          }
        } catch (error) {
          this.#safeReport(error);
        }
      }
    }
    await this.#markConnectionLost(context, roomId);
    return false;
  }

  #identityFor(session: {
    readonly sessionId: string;
    readonly connectionGeneration: number;
  }, connectionId: string): ConnectionIdentity {
    return {
      sessionId: session.sessionId,
      connectionId,
      connectionGeneration: session.connectionGeneration
    };
  }

  async #markConnectionLost(
    context: AuthenticatedConnection,
    roomId: string
  ): Promise<void> {
    try {
      await this.#connectionDispatchRetrier.connectionLost(
        context,
        roomId
      );
    } catch (error) {
      this.#safeReport(error);
    }
  }

  #safeReport(error: unknown): void {
    try {
      this.#report(error);
    } catch {
      // Reporting is a terminal boundary.
    }
  }
}
