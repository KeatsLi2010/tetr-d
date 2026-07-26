import type {
  MatchFeedbackState,
  MatchServerMessage,
  PublicPlayer,
  RoomStatePayload
} from "@tetr-d/protocol";
import type { RoomSettings } from "@tetr-d/room-core";

import type { ServerFrameAnchor } from "./garbagePreviewModel.ts";
import type { NetworkPlayerState } from "./networkPlayerState.ts";

export type DuelConnectionStatus =
  | "entry"
  | "connecting"
  | "connected"
  | "disconnected";

export type MatchStartMessage = Extract<
  MatchServerMessage,
  { readonly type: "match.start" }
>;

export type MatchEndMessage = Extract<
  MatchServerMessage,
  { readonly type: "match.end" }
>;

export interface DuelRoomView {
  readonly connection: DuelConnectionStatus;
  readonly player: PublicPlayer | null;
  readonly room: RoomStatePayload | null;
  readonly match: MatchStartMessage | null;
  readonly players: readonly NetworkPlayerState[];
  readonly result: MatchEndMessage | null;
  readonly frameAnchor: ServerFrameAnchor | null;
  readonly feedback: Readonly<Record<string, MatchFeedbackState>>;
  readonly error: string | null;
}

export interface EnterRoomInput {
  readonly displayName: string;
  readonly roomCode?: string;
}

export interface DuelRoomActions {
  readonly createRoom: (input: EnterRoomInput) => Promise<void>;
  readonly joinRoom: (input: EnterRoomInput) => Promise<void>;
  readonly setReady: (ready: boolean) => void;
  readonly updateSettings: (patch: Partial<RoomSettings>) => void;
  readonly forfeit: () => void;
  readonly nextRound: () => void;
  readonly leave: () => void;
}
