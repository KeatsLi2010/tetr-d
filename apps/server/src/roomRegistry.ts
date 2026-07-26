import { randomBytes, randomUUID } from "node:crypto";

import {
  createRoom
} from "../../../packages/room-core/src/room.ts";
import type {
  CreateRoomInput,
  PublicRoomPlayer,
  RoomSettings
} from "../../../packages/room-core/src/model.ts";
import { RoomActor } from "./roomActor.ts";
import type {
  IsRoomActorPrincipalCurrent,
  RoomActorOptions
} from "./roomActor.ts";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const UNBIASED_BYTE_LIMIT =
  Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;

export interface RoomRegistryOptions {
  readonly maxRooms?: number;
  readonly codeFactory?: () => string;
  readonly roomIdFactory?: () => string;
  readonly actorOptions?: RoomActorOptions;
  readonly isPrincipalCurrent?: IsRoomActorPrincipalCurrent;
}

export interface RegisterRoomInput {
  readonly creator: PublicRoomPlayer;
  readonly connectionId: string;
  readonly nowMs: number;
  readonly settings?: Partial<RoomSettings>;
}

export interface RegisteredRoom {
  readonly roomId: string;
  readonly roomCode: string;
  readonly actor: RoomActor;
}

export function generateRoomCode(): string {
  let code = "";
  while (code.length < CODE_LENGTH) {
    const bytes = randomBytes(CODE_LENGTH * 2);
    for (const byte of bytes) {
      if (byte >= UNBIASED_BYTE_LIMIT) continue;
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

export class RoomRegistry {
  readonly #byId = new Map<string, RegisteredRoom>();
  readonly #roomIdByCode = new Map<string, string>();
  readonly #maxRooms: number;
  readonly #codeFactory: () => string;
  readonly #roomIdFactory: () => string;
  readonly #actorOptions: RoomActorOptions;

  constructor(options: RoomRegistryOptions = {}) {
    this.#maxRooms = options.maxRooms ?? 10_000;
    this.#codeFactory = options.codeFactory ?? generateRoomCode;
    this.#roomIdFactory = options.roomIdFactory ?? randomUUID;
    this.#actorOptions = {
      ...options.actorOptions,
      ...(options.isPrincipalCurrent === undefined
        ? {}
        : { isPrincipalCurrent: options.isPrincipalCurrent })
    };
    if (!Number.isSafeInteger(this.#maxRooms) || this.#maxRooms <= 0) {
      throw new TypeError("Invalid room registry capacity.");
    }
  }

  get size(): number {
    return this.#byId.size;
  }

  create(input: RegisterRoomInput): RegisteredRoom {
    if (this.#byId.size >= this.#maxRooms) {
      throw new Error("ROOM_CAPACITY_REACHED");
    }
    let roomCode: string | null = null;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = this.#codeFactory();
      if (
        /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(candidate) &&
        !this.#roomIdByCode.has(candidate)
      ) {
        roomCode = candidate;
        break;
      }
    }
    if (roomCode === null) throw new Error("ROOM_CODE_EXHAUSTED");

    const roomId = this.#roomIdFactory();
    if (this.#byId.has(roomId)) throw new Error("ROOM_ID_COLLISION");
    const creation: CreateRoomInput = {
      roomId,
      roomCode,
      creator: input.creator,
      connectionId: input.connectionId,
      nowMs: input.nowMs,
      ...(input.settings === undefined ? {} : { settings: input.settings })
    };
    const registered: RegisteredRoom = {
      roomId,
      roomCode,
      actor: new RoomActor(createRoom(creation), this.#actorOptions)
    };
    this.#byId.set(roomId, registered);
    this.#roomIdByCode.set(roomCode, roomId);
    return registered;
  }

  getById(roomId: string): RegisteredRoom | null {
    return this.#byId.get(roomId) ?? null;
  }

  getByCode(roomCode: string): RegisteredRoom | null {
    const roomId = this.#roomIdByCode.get(roomCode.toUpperCase());
    return roomId === undefined ? null : this.#byId.get(roomId) ?? null;
  }

  remove(roomId: string): boolean {
    const room = this.#byId.get(roomId);
    if (room === undefined) return false;
    this.#byId.delete(roomId);
    this.#roomIdByCode.delete(room.roomCode);
    return true;
  }
}
