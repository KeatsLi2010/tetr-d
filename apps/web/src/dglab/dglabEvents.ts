import type { PlayerLockSummary } from "@tetr-d/game-core";

import type { DgLabPenaltyEvent } from "./dglabTypes.ts";

export function soloLockPenaltyEvents(
  previousBackToBack: number,
  previousCombo: number,
  lock: PlayerLockSummary
): readonly DgLabPenaltyEvent[] {
  const events: DgLabPenaltyEvent[] = [];
  if (previousBackToBack > 0 && lock.backToBack === 0) {
    events.push({ kind: "b2bBreak", amount: 1, source: "solo" });
  } else if (lock.backToBack > previousBackToBack && lock.backToBack > 0) {
    events.push({ kind: "b2bContinue", amount: 1, source: "solo" });
  }
  if (lock.combo >= 0 && lock.combo > previousCombo) {
    events.push({ kind: "combo", amount: 1, source: "solo" });
  }
  return Object.freeze(events);
}

export function duelStatePenaltyEvents(
  previous: { readonly backToBack: number; readonly combo: number; readonly pending: number } | null,
  next: { readonly backToBack: number; readonly combo: number; readonly pending: number },
  attackReceived: number,
  attackCancelled: number
): readonly DgLabPenaltyEvent[] {
  if (previous === null) return [];
  const events: DgLabPenaltyEvent[] = [];
  if (previous.backToBack > 0 && next.backToBack === 0) events.push({ kind: "b2bBreak", amount: 1, source: "duel" });
  else if (next.backToBack > previous.backToBack && next.backToBack > 0) events.push({ kind: "b2bContinue", amount: 1, source: "duel" });
  if (next.combo > previous.combo && next.combo >= 0) events.push({ kind: "combo", amount: 1, source: "duel" });
  if (attackReceived > 0) events.push({ kind: "attackReceived", amount: attackReceived, source: "duel" });
  if (attackCancelled > 0) events.push({ kind: "attackCancelled", amount: attackCancelled, source: "duel" });
  return Object.freeze(events);
}

