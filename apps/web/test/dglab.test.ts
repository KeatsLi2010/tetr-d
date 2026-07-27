import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DGLAB_CONFIG,
  DgLabController,
  createPenaltyCommand,
  duelStatePenaltyEvents,
  normalizeDgLabConfig,
  parseWaveformText,
  soloLockPenaltyEvents,
  waveformPayload
} from "../src/dglab/index.ts";
import type { DgLabPenaltyEvent, DgLabTransport, DgLabTransportMessage } from "../src/dglab/index.ts";

class FakeTransport implements DgLabTransport {
  status: "offline" | "connecting" | "paired" | "error" = "offline";
  readonly messages: DgLabTransportMessage[] = [];
  readonly listeners = new Set<(message: DgLabTransportMessage) => void>();
  readonly onStatus: (status: DgLabTransport["status"], clientId: string | null) => void;
  constructor(onStatus: (status: DgLabTransport["status"], clientId: string | null) => void) { this.onStatus = onStatus; }
  connect(): void { this.status = "paired"; this.onStatus("paired", null); }
  close(): void { this.status = "offline"; this.onStatus("offline", null); }
  send(message: DgLabTransportMessage): void { this.messages.push(message); }
  subscribe(listener: (message: DgLabTransportMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  receive(message: DgLabTransportMessage): void { for (const listener of this.listeners) listener(message); }
}

test("DG-LAB config keeps a local safety ceiling", () => {
  assert.equal(DEFAULT_DGLAB_CONFIG.weights.b2bBreak, 5);
  const accepted = normalizeDgLabConfig({ ...DEFAULT_DGLAB_CONFIG, enabled: true, maxStrength: 200 });
  assert.equal(accepted?.maxStrength, 200);
  const config = normalizeDgLabConfig({ ...DEFAULT_DGLAB_CONFIG, enabled: true, maxStrength: 201 });
  assert.equal(config, null);
  assert.equal(DEFAULT_DGLAB_CONFIG.enabled, false);
});

test("waveform presets are valid V3 100ms payload frames", () => {
  for (const id of ["breath", "tide"] as const) {
    const payload = waveformPayload(id);
    assert.ok(payload.length >= 16);
    assert.ok(payload.every((value) => /^[0-9A-F]{16}$/.test(value)));
  }
});

test("custom waveforms accept text, JSON and HEX imports", () => {
  const textFrames = parseWaveformText("12,0\n12,30\n20,80\n20,0");
  assert.deepEqual(textFrames, [
    { frequency: 12, intensity: 0 },
    { frequency: 12, intensity: 30 },
    { frequency: 20, intensity: 80 },
    { frequency: 20, intensity: 0 }
  ]);
  const jsonFrames = parseWaveformText(JSON.stringify([{ frequency: 30, intensity: 20 }, [40, 60], [50, 80], [60, 0]]));
  assert.equal(jsonFrames?.length, 4);
  assert.equal(parseWaveformText(JSON.stringify({ frames: [[30, 20], [40, 60], [50, 80], [60, 0]] }))?.length, 4);
  const hexFrames = parseWaveformText("0C0C0C0C000A141E\n1414141450505050\n1E1E1E1E64646464\n0A0A0A0A00000000");
  assert.equal(hexFrames?.[1]?.frequency, 20);
  assert.equal(hexFrames?.[1]?.intensity, 80);
  const config = normalizeDgLabConfig({ ...DEFAULT_DGLAB_CONFIG, waveform: "custom", customWaveform: textFrames });
  assert.equal(config?.waveform, "custom");
  assert.equal(waveformPayload("custom", textFrames).length, 4);
});

test("b2b break is stronger than a one-step combo", () => {
  const breakEvent: DgLabPenaltyEvent = { kind: "b2bBreak", amount: 1, source: "solo" };
  const comboEvent: DgLabPenaltyEvent = { kind: "combo", amount: 1, source: "solo" };
  const broken = createPenaltyCommand(breakEvent, DEFAULT_DGLAB_CONFIG);
  const combo = createPenaltyCommand(comboEvent, DEFAULT_DGLAB_CONFIG);
  assert.ok(broken && combo);
  assert.ok(broken.strength > combo.strength);
  assert.ok(broken.durationMs > combo.durationMs);
});

test("feedback event amounts scale break and combo but not B2B continuation", () => {
  const lock = {
    piece: "T" as const,
    lines: 1,
    spin: "none" as const,
    combo: 4,
    backToBack: 0,
    perfectClear: false,
    clearedGarbageLines: 0,
    cancelledGarbage: 0,
    outgoingAttacks: [],
    appliedGarbageHoles: []
  };
  const solo = soloLockPenaltyEvents(5, 2, lock);
  assert.deepEqual(solo.map((event) => [event.kind, event.amount]), [["b2bBreak", 5], ["combo", 5]]);
  const continued = soloLockPenaltyEvents(4, 2, { ...lock, backToBack: 5 });
  assert.deepEqual(continued, [{ kind: "b2bContinue", amount: 1, source: "solo" }, { kind: "combo", amount: 5, source: "solo" }]);
  const duel = duelStatePenaltyEvents({ backToBack: 5, combo: 2, pending: 0 }, { backToBack: 0, combo: 4, pending: 0 }, 0, 0);
  assert.deepEqual(duel.map((event) => [event.kind, event.amount]), [["b2bBreak", 5], ["combo", 5]]);
});

test("penalty command keeps continuation fixed while scaling counts", () => {
  const breakOne = createPenaltyCommand({ kind: "b2bBreak", amount: 1, source: "solo" }, DEFAULT_DGLAB_CONFIG);
  const breakFive = createPenaltyCommand({ kind: "b2bBreak", amount: 5, source: "solo" }, DEFAULT_DGLAB_CONFIG);
  const comboOne = createPenaltyCommand({ kind: "combo", amount: 1, source: "solo" }, DEFAULT_DGLAB_CONFIG);
  const comboFive = createPenaltyCommand({ kind: "combo", amount: 5, source: "solo" }, DEFAULT_DGLAB_CONFIG);
  const continueOne = createPenaltyCommand({ kind: "b2bContinue", amount: 1, source: "solo" }, DEFAULT_DGLAB_CONFIG);
  assert.ok(breakOne && breakFive && comboOne && comboFive && continueOne);
  assert.ok(breakFive.points > breakOne.points && comboFive.points > comboOne.points);
  assert.equal(continueOne.points, DEFAULT_DGLAB_CONFIG.weights.b2bContinue);
});

test("controller exposes Bluetooth connection and both channel readings", () => {
  let fake: FakeTransport | null = null;
  const controller = new DgLabController({ ...DEFAULT_DGLAB_CONFIG, enabled: true }, {
    createTransport: (onStatus) => { fake = new FakeTransport(onStatus); return fake; },
    now: () => 10_000
  });
  controller.connect();
  assert.equal(controller.status.connection, "paired");
  assert.equal(controller.arm(), true);
  fake!.receive({ type: "msg", message: "strength-12+7+40+30" });
  assert.deepEqual(controller.status.channels, {
    A: { strength: 12, limit: 40 },
    B: { strength: 7, limit: 30 }
  });
  controller.handleEvent({ kind: "b2bBreak", amount: 1, source: "solo" });
  assert.ok(fake!.messages.some((message) => message.type === "clientMsg"));
  const waveformIndex = fake!.messages.findIndex((message) => message.type === "clientMsg");
  const strengthIndex = fake!.messages.findIndex((message) => message.type === 3);
  assert.ok(waveformIndex >= 0 && strengthIndex >= 0 && waveformIndex < strengthIndex);
  controller.disarm();
  assert.equal(controller.status.armed, false);
  controller.dispose();
});

test("controller adds penalty points, cancels newest points, and schedules decay", () => {
  let now = 10_000;
  let fake: FakeTransport | null = null;
  const controller = new DgLabController({ ...DEFAULT_DGLAB_CONFIG, enabled: true, cooldownMs: 250 }, {
    createTransport: (onStatus) => { fake = new FakeTransport(onStatus); return fake; },
    now: () => now
  });
  controller.connect();
  assert.equal(controller.arm(), true);
  controller.handleEvent({ kind: "b2bBreak", amount: 1, source: "solo" });
  now += 300;
  controller.handleEvent({ kind: "combo", amount: 1, source: "solo" });
  const strengths = () => fake!.messages
    .filter((message) => message.type === 3)
    .map((message) => message.strength);
  assert.deepEqual(strengths().slice(-2), [19, 22]);
  now += 1;
  controller.handleEvent({ kind: "attackCancelled", amount: 1, source: "duel" });
  assert.equal(strengths().at(-1), 16);
  controller.dispose();
});

test("arm reports the local feedback switch separately from Bluetooth pairing", () => {
  const controller = new DgLabController(DEFAULT_DGLAB_CONFIG);
  assert.equal(controller.arm(), false);
  assert.match(controller.status.lastError ?? "", /启用反馈/);
  controller.dispose();
});
