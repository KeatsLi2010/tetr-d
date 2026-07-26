import { Buffer } from "node:buffer";

import { createPlayerPatches } from "../../../../packages/protocol/src/matchStateDelta.ts";
import type {
  MatchEvent,
  MatchServerMessage
} from "../../../../packages/protocol/src/matchMessages.ts";
import type { MatchCoordinatorView } from "./matchCoordinatorTypes.ts";
import { projectMatchSnapshot } from "./matchProjection.ts";

type Snapshot = Extract<
  MatchServerMessage,
  { readonly type: "match.snapshot" }
>;
type Delta = Extract<
  MatchServerMessage,
  { readonly type: "match.delta" }
>;

export interface ProjectedMatchUpdate {
  readonly message: Snapshot | Delta;
  /** Full state represented by message; advance baseline only after send accepts. */
  readonly nextBaseline: Snapshot;
  readonly fullBytes: number;
  readonly sentBytes: number;
}

function visibleEvent(
  event: MatchEvent,
  viewerPlayerId: string
): MatchEvent {
  if (
    event.kind !== "garbage.queued" ||
    event.targetPlayerId === viewerPlayerId
  ) return event;
  return Object.freeze({
    eventSequence: event.eventSequence,
    kind: event.kind,
    packet: event.packet,
    targetPlayerId: event.targetPlayerId
  });
}

function eventsAfter(
  coordinator: MatchCoordinatorView,
  viewerPlayerId: string,
  eventSequence: number
): readonly MatchEvent[] | null {
  if (eventSequence === coordinator.lastEventSequence) return Object.freeze([]);
  if (eventSequence > coordinator.lastEventSequence) return null;
  const events = coordinator.events.filter(
    (event) => event.eventSequence > eventSequence
  );
  if (
    events[0]?.eventSequence !== eventSequence + 1 ||
    events.at(-1)?.eventSequence !== coordinator.lastEventSequence
  ) return null;
  return Object.freeze(
    events.map((event) => visibleEvent(event, viewerPlayerId))
  );
}

function byteLength(message: MatchServerMessage): number {
  return Buffer.byteLength(JSON.stringify(message));
}

export function projectMatchUpdate(
  coordinator: MatchCoordinatorView,
  viewerPlayerId: string,
  baseline: Snapshot | null
): ProjectedMatchUpdate {
  const full = projectMatchSnapshot(coordinator, viewerPlayerId);
  const fullBytes = byteLength(full);
  if (
    baseline === null ||
    baseline.matchId !== full.matchId ||
    baseline.stateSequence >= full.stateSequence
  ) {
    return Object.freeze({
      message: full,
      nextBaseline: full,
      fullBytes,
      sentBytes: fullBytes
    });
  }
  const patches = createPlayerPatches(baseline.players, full.players);
  const events = eventsAfter(
    coordinator,
    viewerPlayerId,
    baseline.lastEventSequence
  );
  if (patches === null || events === null) {
    return Object.freeze({
      message: full,
      nextBaseline: full,
      fullBytes,
      sentBytes: fullBytes
    });
  }
  const delta: Delta = Object.freeze({
    type: "match.delta",
    matchId: full.matchId,
    stateSequence: full.stateSequence,
    baseStateSequence: baseline.stateSequence,
    basePublicStateHash: baseline.publicStateHash,
    lastEventSequence: full.lastEventSequence,
    serverFrame: full.serverFrame,
    publicStateHash: full.publicStateHash,
    selfStateHash: full.selfStateHash,
    patches,
    events,
    self: full.self
  });
  const deltaBytes = byteLength(delta);
  const message = deltaBytes < fullBytes ? delta : full;
  return Object.freeze({
    message,
    nextBaseline: full,
    fullBytes,
    sentBytes: message === delta ? deltaBytes : fullBytes
  });
}
