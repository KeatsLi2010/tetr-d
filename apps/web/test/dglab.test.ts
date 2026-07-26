import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DGLAB_CONFIG,
  DgLabController,
  createPenaltyCommand,
  normalizeDgLabConfig,
  parseWaveformText,
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
