import type {
  ClientMessage,
  ServerMessage
} from "@tetr-d/protocol";
import type { RoomSettings } from "@tetr-d/room-core";

import type { DuelRoomView } from "./duelTypes.ts";

type ProtocolError = Extract<ServerMessage, { readonly type: "error" }>;
type CommandOk = Extract<
  ServerMessage,
  { readonly type: "room.command.ok" }
>;

type RoomIntent =
  | { readonly kind: "ready"; readonly ready: boolean }
  | { readonly kind: "settings"; readonly patch: Partial<RoomSettings> }
  | { readonly kind: "rematch" }
  | { readonly kind: "forfeit"; readonly matchId: string };

interface PendingCommand {
  readonly intent: RoomIntent;
  readonly retries: number;
  readonly requestId: string;
  readonly waitForRevision: number | null;
  readonly acknowledgedRevision: number | null;
}

export interface DuelRoomCommandsOptions {
  readonly getView: () => DuelRoomView;
  readonly send: (message: ClientMessage) => boolean;
}

export class DuelRoomCommands {
  readonly #options: DuelRoomCommandsOptions;
  #pending: PendingCommand | null = null;
  #requestOrdinal = 0;

  constructor(options: DuelRoomCommandsOptions) {
    this.#options = options;
  }

  setReady(ready: boolean): void {
    this.#begin({ kind: "ready", ready });
  }

  updateSettings(patch: Partial<RoomSettings>): void {
    this.#begin({ kind: "settings", patch });
  }

  nextRound(): void {
    const room = this.#options.getView().room;
    if (room?.phase === "series_complete") {
      this.#begin({ kind: "rematch" });
    } else {
      this.#begin({ kind: "ready", ready: true });
    }
  }

  forfeit(): void {
    const match = this.#options.getView().match;
    if (match !== null) {
      this.#begin({ kind: "forfeit", matchId: match.matchId });
    }
  }

  handleCommandOk(message: CommandOk): void {
    if (message.requestId !== this.#pending?.requestId) return;
    this.#pending = {
      ...this.#pending,
      acknowledgedRevision: message.revision
    };
    const roomRevision = this.#options.getView().room?.revision ?? -1;
    if (roomRevision >= message.revision) this.#pending = null;
  }

  handleRoomState(revision: number): void {
    const pending = this.#pending;
    if (pending === null) return;
    if (
      pending.acknowledgedRevision !== null &&
      revision >= pending.acknowledgedRevision
    ) {
      this.#pending = null;
      return;
    }
    if (
      pending.waitForRevision !== null &&
      revision >= pending.waitForRevision
    ) {
      this.#pending = {
        ...pending,
        retries: pending.retries + 1,
        requestId: this.#requestId(pending.intent.kind),
        waitForRevision: null
      };
      this.#dispatch();
    }
  }

  handleError(message: ProtocolError): boolean {
    const pending = this.#pending;
    if (
      pending === null ||
      message.requestId !== pending.requestId
    ) return false;
    if (
      message.code === "REVISION_CONFLICT" &&
      pending.retries === 0
    ) {
      const revision = message.currentRevision ??
        this.#options.getView().room?.revision;
      if (revision !== undefined) {
        this.#pending = { ...pending, waitForRevision: revision };
        const current = this.#options.getView().room?.revision ?? -1;
        if (current >= revision) this.handleRoomState(current);
        return true;
      }
    }
    this.#pending = null;
    return false;
  }

  reset(): void {
    this.#pending = null;
  }

  #begin(intent: RoomIntent): void {
    if (this.#pending !== null) return;
    this.#pending = {
      intent,
      retries: 0,
      requestId: this.#requestId(intent.kind),
      waitForRevision: null,
      acknowledgedRevision: null
    };
    this.#dispatch();
  }

  #dispatch(): void {
    const pending = this.#pending;
    const room = this.#options.getView().room;
    if (pending === null || room === null) {
      this.#pending = null;
      return;
    }
    const common = {
      requestId: pending.requestId,
      roomId: room.roomId,
      expectedRevision: room.revision
    };
    let message: ClientMessage;
    if (pending.intent.kind === "ready") {
      message = {
        type: "room.ready.set",
        ...common,
        ready: pending.intent.ready
      };
    } else if (pending.intent.kind === "settings") {
      message = {
        type: "room.settings.update",
        ...common,
        patch: pending.intent.patch
      };
    } else if (pending.intent.kind === "rematch") {
      message = {
        type: "room.series.rematch",
        ...common,
        accepted: true
      };
    } else {
      message = {
        type: "match.forfeit",
        ...common,
        matchId: pending.intent.matchId
      };
    }
    if (!this.#options.send(message)) this.#pending = null;
  }

  #requestId(action: string): string {
    this.#requestOrdinal += 1;
    return `${action}-${Date.now().toString(36)}-${this.#requestOrdinal}`;
  }
}
