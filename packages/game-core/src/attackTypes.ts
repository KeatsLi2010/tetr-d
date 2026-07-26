export const VERSUS_ATTACK_RULESET_VERSION =
  "tetrio-s2-observed-v1" as const;

export type VersusAttackRulesetVersion =
  typeof VERSUS_ATTACK_RULESET_VERSION;
export type ClearedLines = 1 | 2 | 3 | 4;
export type SpinClassification = "none" | "mini" | "full";
export type AttackRoundingMode = "rng" | "down";

export interface VersusAttackRoundingOptions {
  /** Defaults to the current TETRA LEAGUE Season 2 profile: RNG. */
  readonly roundingMode?: AttackRoundingMode;
  /** Deterministic sample in [0, 1), required for fractional RNG rounding. */
  readonly roundingRoll?: number;
}

export interface VersusAttackEvent {
  readonly lines: ClearedLines;
  readonly spin: SpinClassification;
  /**
   * TETR.IO combo index: the first consecutive clear is 0, the next is 1.
   */
  readonly combo: number;
  readonly allClear?: boolean;
  /**
   * True when this clear removed at least one row containing garbage.
   */
  readonly clearedGarbage?: boolean;
}

export interface BackToBackChargeState {
  /**
   * Consecutive difficult clears, including the first clear that starts B2B.
   * The displayed B2B count is therefore max(0, streak - 1).
   */
  readonly difficultClearStreak: number;
}

export interface BackToBackChargeStatus {
  readonly displayedCount: number;
  readonly surgeCharge: number;
}

export interface VersusAttackResolution {
  readonly rulesetVersion: VersusAttackRulesetVersion;
  readonly difficult: boolean;
  readonly baseAttack: number;
  readonly backToBackBonus: 0 | 1;
  readonly comboMultiplier: number;
  readonly scaledAttackBeforeRounding: number;
  readonly roundingMode: AttackRoundingMode;
  readonly roundingFraction: number;
  readonly roundedAttack: number;
  readonly allClearBonus: 0 | 5;
  readonly garbageClearBonus: 0 | 1;
  readonly clearAttack: number;
  /**
   * Surge is separate from clearAttack. The coordinator can preserve packet
   * boundaries while applying queue cancellation and garbage-hole RNG.
   */
  readonly surgePackets: readonly number[];
  readonly nextBackToBack: BackToBackChargeState;
  readonly nextBackToBackStatus: BackToBackChargeStatus;
}

export interface OpenerCancellationContext {
  /**
   * Count before the current piece locks; 0 through 13 are opener pieces.
   */
  readonly piecesPlacedBeforeLock: number;
  readonly pendingGarbage: number;
  readonly totalAttackSent: number;
}
