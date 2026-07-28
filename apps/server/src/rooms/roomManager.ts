import type {
  RoomSettings,
  RoomState
} from "../../../../packages/room-core/src/model.ts";
import type {
  IsRoomActorPrincipalCurrent,
  RoomActorPrincipal,
  RoomDispatchResult,
  RoomSystemCommand,
  RoomUserCommand
} from "../roomActor.ts";
import {
  RoomRegistry
} from "../roomRegistry.ts";
import type {
  RegisteredRoom,
  RoomRegistryOptions
} from "../roomRegistry.ts";
import {
  RoomRuntime
} from "./roomRuntime.ts";
import type {
  RoomRuntimeCommit
} from "./roomRuntime.ts";
import type { RoomScheduler } from "./roomScheduler.ts";

export interface RoomManagerOptions {
  readonly registryOptions?: RoomRegistryOptions;
  readonly now?: () => number;
  readonly isPrincipalCurrent?: IsRoomActorPrincipalCurrent;
  readonly schedulerFactory?: (roomId: string) => RoomScheduler;
  readonly matchIdFactory?: () => string;
  readonly onCommit?: (
    roomId: string,
    commit: RoomRuntimeCommit
  ) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
  readonly dispatchQueueCapacity?: number;
}

export interface CreateManagedRoomInput {
  readonly principal: RoomActorPrincipal;
  readonly roomCode?: string;
  readonly settings?: Partial<RoomSettings>;
}

export interface ManagedRoomView {
  readonly roomId: string;
  readonly roomCode: string;
  readonly state: RoomState;
}

export class RoomManager {
  readonly #registry: RoomRegistry;
  readonly #runtimes = new Map<string, RoomRuntime>();
  readonly #now: () => number;
  readonly #schedulerFactory:
    | ((roomId: string) => RoomScheduler)
    | undefined;
  readonly #matchIdFactory: (() => string) | undefined;
  readonly #onCommit: (
    roomId: string,
    commit: RoomRuntimeCommit
  ) => void | Promise<void>;
  readonly #onError: (error: unknown) => void;
  readonly #dispatchQueueCapacity: number | undefined;
  #disposed = false;

  constructor(options: RoomManagerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#registry = new RoomRegistry({
      ...options.registryOptions,
      ...(options.isPrincipalCurrent === undefined
        ? {}
        : { isPrincipalCurrent: options.isPrincipalCurrent }),
      actorOptions: {
        ...options.registryOptions?.actorOptions,
        now: this.#now
      }
    });
    this.#schedulerFactory = options.schedulerFactory;
    this.#matchIdFactory = options.matchIdFactory;
    this.#onCommit = options.onCommit ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
    this.#dispatchQueueCapacity = options.dispatchQueueCapacity;
  }

  get size(): number {
    return this.#runtimes.size;
  }

  create(input: CreateManagedRoomInput): ManagedRoomView {
    this.#assertActive();
    const registered = this.#registry.create({
      creator: input.principal.player,
      connectionId: input.principal.connectionId,
      nowMs: this.#readNow(),
      ...(input.roomCode === undefined ? {} : { roomCode: input.roomCode }),
      ...(input.settings === undefined ? {} : { settings: input.settings })
    });
    const runtime = this.#install(registered);
    return this.#view(registered, runtime);
  }

  getById(roomId: string): ManagedRoomView | null {
    this.#assertActive();
    const registered = this.#registry.getById(roomId);
    if (registered === null) return null;
    return this.#view(registered, this.#runtimeFor(registered));
  }

  getByCode(roomCode: string): ManagedRoomView | null {
    this.#assertActive();
    const registered = this.#registry.getByCode(roomCode);
    if (registered === null) return null;
    return this.#view(registered, this.#runtimeFor(registered));
  }

  async joinByCode(
    principal: RoomActorPrincipal,
    roomCode: string,
    command: Extract<RoomUserCommand, { readonly type: "member.join" }>
  ): Promise<RoomDispatchResult | null> {
    this.#assertActive();
    const registered = this.#registry.getByCode(roomCode);
    if (registered === null) return null;
    return this.#runtimeFor(registered).dispatchUser(principal, command);
  }

  dispatchUser(
    roomId: string,
    principal: RoomActorPrincipal,
    command: Exclude<RoomUserCommand, { readonly type: "member.join" }>
  ): Promise<RoomDispatchResult> | null {
    this.#assertActive();
    const registered = this.#registry.getById(roomId);
    if (registered === null) return null;
    return this.#runtimeFor(registered).dispatchUser(principal, command);
  }

  dispatchSystem(
    roomId: string,
    command: RoomSystemCommand
  ): Promise<RoomDispatchResult> | null {
    this.#assertActive();
    const registered = this.#registry.getById(roomId);
    if (registered === null) return null;
    return this.#runtimeFor(registered).dispatchSystem(command);
  }

  connectionLost(
    roomId: string,
    playerId: string,
    connectionId: string
  ): Promise<RoomDispatchResult> | null {
    this.#assertActive();
    const room = this.#registry.getById(roomId);
    if (room === null) return null;
    const runtime = this.#runtimeFor(room);
    const member = runtime.snapshot.members[playerId];
    if (
      member === undefined ||
      member.connection.kind !== "connected" ||
      member.connection.connectionId !== connectionId
    ) {
      return null;
    }
    return runtime.dispatchSystem({
      type: "connection.lost",
      playerId,
      connectionId,
      expectedConnectionEpoch: member.connection.epoch
    });
  }

  restoreConnection(
    roomId: string,
    playerId: string,
    newConnectionId: string
  ): Promise<RoomDispatchResult> | null {
    this.#assertActive();
    const room = this.#registry.getById(roomId);
    if (room === null) return null;
    const runtime = this.#runtimeFor(room);
    const member = runtime.snapshot.members[playerId];
    if (member === undefined) return null;
    if (member.connection.kind === "connected") {
      if (member.connection.connectionId === newConnectionId) return null;
      return runtime.dispatchSystem({
        type: "connection.replace",
        playerId,
        expectedConnectionId: member.connection.connectionId,
        expectedConnectionEpoch: member.connection.epoch,
        newConnectionId
      });
    }
    return runtime.dispatchSystem({
      type: "connection.resumed",
      playerId,
      expectedConnectionEpoch: member.connection.epoch,
      newConnectionId
    });
  }

  remove(roomId: string): boolean {
    this.#assertActive();
    const runtime = this.#runtimes.get(roomId);
    runtime?.dispose();
    this.#runtimes.delete(roomId);
    return this.#registry.remove(roomId);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [roomId, runtime] of this.#runtimes) {
      runtime.dispose();
      this.#registry.remove(roomId);
    }
    this.#runtimes.clear();
  }

  #runtimeFor(room: RegisteredRoom): RoomRuntime {
    return this.#runtimes.get(room.roomId) ?? this.#install(room);
  }

  #install(room: RegisteredRoom): RoomRuntime {
    const existing = this.#runtimes.get(room.roomId);
    if (existing !== undefined) return existing;
    const scheduler = this.#schedulerFactory?.(room.roomId);
    const runtime = new RoomRuntime(room.actor, {
      now: this.#now,
      ...(this.#dispatchQueueCapacity === undefined
        ? {}
        : { dispatchQueueCapacity: this.#dispatchQueueCapacity }),
      ...(scheduler === undefined ? {} : { scheduler }),
      ...(this.#matchIdFactory === undefined
        ? {}
        : { matchIdFactory: this.#matchIdFactory }),
      onCommit: (commit) => this.#onCommit(room.roomId, commit),
      onError: this.#onError
    });
    this.#runtimes.set(room.roomId, runtime);
    return runtime;
  }

  #view(room: RegisteredRoom, runtime: RoomRuntime): ManagedRoomView {
    return Object.freeze({
      roomId: room.roomId,
      roomCode: room.roomCode,
      state: runtime.snapshot
    });
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Room manager clock returned an invalid timestamp.");
    }
    return value;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Room manager is disposed.");
  }
}
