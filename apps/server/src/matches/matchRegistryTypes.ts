import type { RoomState } from "../../../../packages/room-core/src/model.ts";
import type { PublicPlayer } from "../../../../packages/protocol/src/roomMessages.ts";
import type { SessionStore } from "../auth/sessionStore.ts";
import type { ConnectionHub } from "../gateway/connectionHub.ts";
import type { MatchPieceSequence } from "../matchPieceSequence.ts";
import type {
  FixedStepClock,
  FixedStepOverloadEvent,
  FixedStepScheduler
} from "./fixedStepLoop.ts";
import type { MatchFinishedResult } from "./matchCoordinatorTypes.ts";

export interface StartRegisteredMatch {
  readonly matchId: string;
  readonly roomId: string;
  readonly participants: readonly [string, string];
  readonly players: readonly [PublicPlayer, PublicPlayer];
}

export interface MatchRegistryOptions {
  readonly sessions: SessionStore;
  readonly connections: ConnectionHub;
  readonly tickRateHz: number;
  readonly snapshotRateHz?: number;
  readonly replayRootDirectory?: string;
  readonly serverVersion?: string;
  readonly now?: () => number;
  readonly getRoomState: (roomId: string) => RoomState | null;
  readonly onMatchFinished: (
    result: MatchFinishedResult
  ) => void | Promise<void>;
  readonly sequenceFactory?: (input: StartRegisteredMatch) => MatchPieceSequence;
  readonly clock?: FixedStepClock;
  readonly scheduler?: FixedStepScheduler;
  readonly onOverload?: (event: FixedStepOverloadEvent) => void;
  readonly onError?: (error: unknown) => void;
}
