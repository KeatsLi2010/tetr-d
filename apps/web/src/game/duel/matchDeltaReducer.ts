import {
  applyPlayerPatches,
  type MatchServerMessage
} from "@tetr-d/protocol";

export type MatchSnapshot = Extract<
  MatchServerMessage,
  { readonly type: "match.snapshot" }
>;
export type MatchDelta = Extract<
  MatchServerMessage,
  { readonly type: "match.delta" }
>;

export type MatchDeltaReduction =
  | { readonly status: "accepted"; readonly snapshot: MatchSnapshot }
  | { readonly status: "stale" }
  | { readonly status: "resync" };

function hasContiguousEvents(
  baseline: MatchSnapshot,
  delta: MatchDelta
): boolean {
  if (delta.lastEventSequence < baseline.lastEventSequence) return false;
  if (delta.lastEventSequence === baseline.lastEventSequence) {
    return delta.events.length === 0;
  }
  let expected = baseline.lastEventSequence + 1;
  for (const event of delta.events) {
    if (event.eventSequence !== expected) return false;
    expected += 1;
  }
  return expected - 1 === delta.lastEventSequence;
}

export function reduceMatchDelta(
  baseline: MatchSnapshot | null,
  delta: MatchDelta
): MatchDeltaReduction {
  if (baseline !== null && delta.stateSequence <= baseline.stateSequence) {
    return Object.freeze({ status: "stale" });
  }
  if (
    baseline === null ||
    delta.matchId !== baseline.matchId ||
    delta.baseStateSequence !== baseline.stateSequence ||
    delta.basePublicStateHash !== baseline.publicStateHash ||
    !hasContiguousEvents(baseline, delta)
  ) return Object.freeze({ status: "resync" });
  try {
    const players = applyPlayerPatches(baseline.players, delta.patches);
    const snapshot: MatchSnapshot = Object.freeze({
      type: "match.snapshot",
      matchId: delta.matchId,
      stateSequence: delta.stateSequence,
      lastEventSequence: delta.lastEventSequence,
      serverFrame: delta.serverFrame,
      publicStateHash: delta.publicStateHash,
      selfStateHash: delta.selfStateHash,
      players,
      self: delta.self,
      ...(delta.acknowledgement === undefined
        ? {}
        : { acknowledgement: delta.acknowledgement })
    });
    return Object.freeze({ status: "accepted", snapshot });
  } catch {
    return Object.freeze({ status: "resync" });
  }
}
