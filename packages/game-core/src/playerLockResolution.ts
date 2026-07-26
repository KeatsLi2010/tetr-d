import { lockPiece, type Board } from "./board.ts";
import {
  backToBackChargeStatus,
  openerCancellationMultiplier,
  resolveVersusAttack
} from "./versusAttack.ts";
import type {
  BackToBackChargeState,
  VersusAttackEvent,
  VersusAttackResolution
} from "./attackTypes.ts";
import {
  applyReadyGarbage,
  cancelGarbageWithAttack,
  pendingGarbageAmount,
  type SimulationGarbagePacket
} from "./garbageQueue.ts";
import type { PlayerLockSummary } from "./playerSimulationTypes.ts";
import {
  classifyAllMiniPlusSpin,
  type LastSuccessfulRotation
} from "./spinDetection.ts";
import type { ActivePiece } from "./types.ts";

interface PlayerLockResolutionOptions {
  readonly board: Board;
  readonly piece: ActivePiece;
  readonly lastRotation: LastSuccessfulRotation | null;
  readonly combo: number;
  readonly backToBack: BackToBackChargeState;
  readonly piecesPlacedBeforeLock: number;
  readonly totalAttackSent: number;
  readonly pendingGarbage: readonly SimulationGarbagePacket[];
  readonly serverFrame: number;
  readonly garbageCap: number;
  readonly nextAttackRoundingRoll: () => number;
}

export interface PlayerLockResolution {
  readonly board: Board;
  readonly combo: number;
  readonly backToBack: BackToBackChargeState;
  readonly totalAttackSent: number;
  readonly pendingGarbage: readonly SimulationGarbagePacket[];
  readonly toppedOut: boolean;
  readonly summary: PlayerLockSummary;
}

function readRoundingRoll(source: () => number): number {
  const roll = source();
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
    throw new RangeError("Attack rounding source returned an invalid value.");
  }
  return roll;
}

function resolveAttack(
  event: VersusAttackEvent,
  backToBack: BackToBackChargeState,
  nextRoundingRoll: () => number
): VersusAttackResolution {
  const probe = resolveVersusAttack(event, backToBack, {
    roundingMode: "down"
  });
  return resolveVersusAttack(
    event,
    backToBack,
    probe.roundingFraction === 0
      ? undefined
      : { roundingRoll: readRoundingRoll(nextRoundingRoll) }
  );
}

export function resolvePlayerLock(
  options: PlayerLockResolutionOptions
): PlayerLockResolution {
  const spin = classifyAllMiniPlusSpin(
    options.board,
    options.piece,
    options.lastRotation
  );
  const locked = lockPiece(options.board, options.piece);
  let board = locked.board;
  let combo = options.combo;
  let backToBack = options.backToBack;
  let totalAttackSent = options.totalAttackSent;
  let pendingGarbage = options.pendingGarbage;
  let toppedOut = false;
  let cancelledGarbage = 0;
  const appliedHoles: number[] = [];
  const outgoing: number[] = [];

  if (locked.clearedLineCount > 0) {
    combo += 1;
    const resolution = resolveAttack({
      lines: locked.clearedLineCount as 1 | 2 | 3 | 4,
      spin,
      combo,
      allClear: locked.perfectClear,
      clearedGarbage: locked.clearedGarbage
    }, backToBack, options.nextAttackRoundingRoll);
    backToBack = resolution.nextBackToBack;
    const multiplier = openerCancellationMultiplier({
      piecesPlacedBeforeLock: options.piecesPlacedBeforeLock,
      pendingGarbage: pendingGarbageAmount(pendingGarbage),
      totalAttackSent
    });
    for (const attack of [resolution.clearAttack, ...resolution.surgePackets]) {
      if (attack === 0) continue;
      const cancellation = cancelGarbageWithAttack(
        pendingGarbage,
        attack,
        multiplier
      );
      pendingGarbage = cancellation.packets;
      cancelledGarbage += cancellation.cancelled;
      if (cancellation.outgoing > 0) outgoing.push(cancellation.outgoing);
    }
    totalAttackSent += outgoing.reduce((sum, value) => sum + value, 0);
  } else {
    combo = -1;
    const applied = applyReadyGarbage(
      board,
      pendingGarbage,
      options.serverFrame,
      options.garbageCap
    );
    board = applied.board;
    pendingGarbage = applied.packets;
    appliedHoles.push(...applied.appliedHoles);
    toppedOut = applied.overflowed;
  }

  return {
    board,
    combo,
    backToBack,
    totalAttackSent,
    pendingGarbage,
    toppedOut,
    summary: Object.freeze({
      piece: options.piece.kind,
      lines: locked.clearedLineCount,
      spin,
      combo,
      backToBack: backToBackChargeStatus(backToBack).displayedCount,
      perfectClear: locked.perfectClear,
      clearedGarbageLines: locked.clearedGarbageLineCount,
      cancelledGarbage,
      outgoingAttacks: Object.freeze(outgoing),
      appliedGarbageHoles: Object.freeze(appliedHoles)
    })
  };
}
