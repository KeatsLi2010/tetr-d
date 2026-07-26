import type { RoomErrorCode } from "../../room-core/src/model.ts";
import type {
  MatchClientMessage,
  MatchServerMessage
} from "./matchMessages.ts";
import type {
  PublicPlayer,
  RoomClientMessage,
  RoomServerMessage
} from "./roomMessages.ts";

export * from "./matchMessages.ts";
export * from "./roomMessages.ts";
export * from "./versions.ts";

export type ClientMessage =
  | {
      readonly type: "hello";
      readonly protocolVersion: number;
      readonly buildId: string;
      readonly resumeToken?: string;
    }
  | { readonly type: "auth.guest"; readonly displayName: string }
  | RoomClientMessage
  | MatchClientMessage
  | { readonly type: "ping"; readonly clientTime: number };

export type ProtocolErrorCode =
  | RoomErrorCode
  | "PROTOCOL_MISMATCH"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "ROOM_NOT_FOUND"
  | "MESSAGE_INVALID";

export type ServerMessage =
  | {
      readonly type: "welcome";
      readonly protocolVersion: number;
      readonly connectionId: string;
      readonly heartbeatMs: number;
    }
  | {
      readonly type: "auth.ok";
      readonly player: PublicPlayer;
      readonly resumeToken: string;
    }
  | RoomServerMessage
  | MatchServerMessage
  | {
      readonly type: "pong";
      readonly clientTime: number;
      readonly serverTime: number;
    }
  | {
      readonly type: "error";
      readonly code: ProtocolErrorCode;
      readonly message: string;
      readonly retryable: boolean;
      readonly requestId?: string;
      readonly currentRevision?: number;
    };
