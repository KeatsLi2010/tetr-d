import {
  VERSUS_ATTACK_RULESET_VERSION,
  type AttackRoundingMode,
  type BackToBackChargeState,
  type BackToBackChargeStatus,
  type ClearedLines,
  type OpenerCancellationContext,
  type SpinClassification,
  type VersusAttackEvent,
  type VersusAttackRoundingOptions,
  type VersusAttackResolution
} from "./attackTypes.ts";

export const TETRIO_S2_ATTACK_RULES = Object.freeze({
  version: VERSUS_ATTACK_RULESET_VERSION,
  defaultRoundingMode: "rng",
  comboStep: 0.25,
  zeroBaseComboScale: 1.25,
  backToBackBonus: 1,
  surgeStartsAtDisplayedBackToBack: 4,
  allClearBonus: 5,
  garbageClearBonus: 1,
  openerPieces: 14,
  openerCancelMultiplier: 2
} as const);

export const INITIAL_BACK_TO_BACK_CHARGE_STATE: BackToBackChargeState =
  Object.freeze({ difficultClearStreak: 0 });

const BASE_ATTACK: Readonly<
  Record<SpinClassification, Readonly<Record<ClearedLines, number>>>
> = Object.freeze({
  none: Object.freeze({ 1: 0, 2: 1, 3: 2, 4: 4 }),
  mini: Object.freeze({ 1: 0, 2: 1, 3: 2, 4: 4 }),
  full: Object.freeze({ 1: 2, 2: 4, 3: 6, 4: 10 })
});

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertRoundingRoll(roll: number): void {
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
    throw new RangeError("roundingRoll must be in [0, 1)");
  }
}

function validateState(state: BackToBackChargeState): void {
  assertNonNegativeInteger(
    state.difficultClearStreak,
    "difficultClearStreak"
  );
}

export function baseAttackFor(
  lines: ClearedLines,
  spin: SpinClassification
): number {
  return BASE_ATTACK[spin][lines];
}

export function isDifficultClear(event: VersusAttackEvent): boolean {
  return (
    event.lines === 4 ||
    event.spin !== "none" ||
    event.allClear === true
  );
}

export function backToBackChargeStatus(
  state: BackToBackChargeState
): BackToBackChargeStatus {
  validateState(state);
  const displayedCount = Math.max(0, state.difficultClearStreak - 1);

  return {
    displayedCount,
    surgeCharge:
      displayedCount >=
      TETRIO_S2_ATTACK_RULES.surgeStartsAtDisplayedBackToBack
        ? displayedCount
        : 0
  };
}

/**
 * Splits a Surge into exactly three packets. Remainders go to the first,
 * then the second packet, matching TETR.IO's documented packet ordering.
 */
export function splitSurgeAttack(charge: number): readonly number[] {
  assertNonNegativeInteger(charge, "charge");
  if (charge === 0) return [];

  const quotient = Math.floor(charge / 3);
  const remainder = charge % 3;
  return [0, 1, 2].map(
    (packetIndex) => quotient + (packetIndex < remainder ? 1 : 0)
  );
}

export function roundVersusAttack(
  attack: number,
  roundingMode: AttackRoundingMode,
  roundingRoll?: number
): number {
  if (!Number.isFinite(attack) || attack < 0) {
    throw new RangeError("attack must be a non-negative finite number");
  }

  const floored = Math.floor(attack);
  if (roundingMode === "down") return floored;

  const fraction = attack - floored;
  if (fraction === 0) return floored;
  if (roundingRoll === undefined) {
    throw new RangeError(
      "roundingRoll is required for fractional RNG rounding"
    );
  }

  assertRoundingRoll(roundingRoll);
  return floored + (roundingRoll < fraction ? 1 : 0);
}

function roundedMultiplierAttack(
  baseWithBackToBack: number,
  combo: number,
  options: VersusAttackRoundingOptions
): {
  readonly comboMultiplier: number;
  readonly scaledAttackBeforeRounding: number;
  readonly roundingMode: AttackRoundingMode;
  readonly roundingFraction: number;
  readonly roundedAttack: number;
} {
  const comboMultiplier = 1 + TETRIO_S2_ATTACK_RULES.comboStep * combo;
  let scaledAttackBeforeRounding = baseWithBackToBack * comboMultiplier;

  if (baseWithBackToBack === 0 && combo >= 2) {
    scaledAttackBeforeRounding = Math.max(
      scaledAttackBeforeRounding,
      Math.log(
        1 + TETRIO_S2_ATTACK_RULES.zeroBaseComboScale * combo
      )
    );
  }

  const roundingMode =
    options.roundingMode ?? TETRIO_S2_ATTACK_RULES.defaultRoundingMode;

  return {
    comboMultiplier,
    scaledAttackBeforeRounding,
    roundingMode,
    roundingFraction:
      scaledAttackBeforeRounding - Math.floor(scaledAttackBeforeRounding),
    roundedAttack: roundVersusAttack(
      scaledAttackBeforeRounding,
      roundingMode,
      options.roundingRoll
    )
  };
}

export function resolveVersusAttack(
  event: VersusAttackEvent,
  state: BackToBackChargeState = INITIAL_BACK_TO_BACK_CHARGE_STATE,
  options: VersusAttackRoundingOptions = {}
): VersusAttackResolution {
  assertNonNegativeInteger(event.combo, "combo");
  validateState(state);

  const difficult = isDifficultClear(event);
  const backToBackBonus =
    difficult && state.difficultClearStreak > 0 ? 1 : 0;
  const baseAttack = baseAttackFor(event.lines, event.spin);
  const multiplierAttack = roundedMultiplierAttack(
    baseAttack + backToBackBonus,
    event.combo,
    options
  );
  const allClearBonus = event.allClear === true ? 5 : 0;
  const garbageClearBonus =
    event.clearedGarbage === true &&
    (event.lines === 4 || event.spin !== "none")
      ? 1
      : 0;

  const previousStatus = backToBackChargeStatus(state);
  const surgePackets = difficult
    ? []
    : splitSurgeAttack(previousStatus.surgeCharge);
  const nextBackToBack: BackToBackChargeState = {
    difficultClearStreak: difficult
      ? state.difficultClearStreak + 1
      : 0
  };

  return {
    rulesetVersion: VERSUS_ATTACK_RULESET_VERSION,
    difficult,
    baseAttack,
    backToBackBonus,
    ...multiplierAttack,
    allClearBonus,
    garbageClearBonus,
    clearAttack:
      multiplierAttack.roundedAttack +
      allClearBonus +
      garbageClearBonus,
    surgePackets,
    nextBackToBack,
    nextBackToBackStatus: backToBackChargeStatus(nextBackToBack)
  };
}

/**
 * Returns only the documented Season 2 opener cancellation multiplier.
 *
 * Queue consumption for odd pending values and same-tick ordering are left to
 * a separately versioned coordinator policy because TETR.IO has not publicly
 * documented those boundary rules.
 */
export function openerCancellationMultiplier(
  context: OpenerCancellationContext
): 1 | 2 {
  assertNonNegativeInteger(
    context.piecesPlacedBeforeLock,
    "piecesPlacedBeforeLock"
  );
  assertNonNegativeInteger(context.pendingGarbage, "pendingGarbage");
  assertNonNegativeInteger(context.totalAttackSent, "totalAttackSent");

  return context.piecesPlacedBeforeLock <
    TETRIO_S2_ATTACK_RULES.openerPieces &&
    context.pendingGarbage > context.totalAttackSent
    ? 2
    : 1;
}
