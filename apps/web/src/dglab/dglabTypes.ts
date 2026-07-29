export type DgLabChannel = "A" | "B";

/** Physical output selection. `both` mirrors the same penalty to A and B. */
export type DgLabOutputChannel = DgLabChannel | "both";

export type DgLabWaveformId = "breath" | "tide" | "custom";

export interface DgLabWaveformFrame {
  readonly frequency: number;
  readonly intensity: number;
  readonly frequencySteps?: readonly [number, number, number, number];
  readonly intensitySteps?: readonly [number, number, number, number];
}

export type DgLabPenaltyEventKind =
  | "b2bBreak"
  | "b2bContinue"
  | "combo"
  | "attackReceived"
  | "attackCancelled"
  | "defeat";

export interface DgLabPenaltyEvent {
  readonly kind: DgLabPenaltyEventKind;
  readonly amount: number;
  readonly source: "solo" | "duel";
}

export interface DgLabPenaltyWeights {
  readonly b2bBreak: number;
  readonly b2bContinue: number;
  readonly combo: number;
  readonly attackReceived: number;
  readonly attackCancelled: number;
}

export interface DgLabConfig {
  readonly version: 1;
  readonly enabled: boolean;
  readonly waveform: DgLabWaveformId;
  readonly customWaveform: readonly DgLabWaveformFrame[];
  readonly channel: DgLabOutputChannel;
  readonly maxStrength: number;
  readonly baseStrength: number;
  readonly strengthPerPoint: number;
  readonly baseDurationMs: number;
  readonly durationPerPointMs: number;
  readonly cooldownMs: number;
  readonly maxQueueSeconds: number;
  readonly weights: DgLabPenaltyWeights;
}

export type DgLabConnectionStatus =
  | "offline"
  | "connecting"
  | "paired"
  | "error";

export interface DgLabChannelState {
  readonly strength: number;
  readonly limit: number;
}

export interface DgLabStatus {
  readonly connection: DgLabConnectionStatus;
  readonly armed: boolean;
  readonly channels: Readonly<Record<DgLabChannel, DgLabChannelState>>;
  readonly queuedSeconds: number;
  readonly lastError: string | null;
}

export interface DgLabTransportMessage {
  readonly type: string | number;
  readonly clientId?: string;
  readonly targetId?: string;
  readonly message?: string;
  readonly channel?: string | number;
  readonly strength?: number;
  readonly time?: number;
  readonly durationMs?: number;
}

export interface DgLabTransport {
  readonly connect: (forceChooser?: boolean) => void;
  readonly close: () => void;
  readonly send: (message: DgLabTransportMessage) => void;
  readonly setSafetyLimit?: (strength: number) => void;
  readonly subscribe: (listener: (message: DgLabTransportMessage) => void) => () => void;
  readonly status: DgLabConnectionStatus;
}
