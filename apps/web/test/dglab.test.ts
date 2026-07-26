import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DGLAB_CONFIG,
  DgLabController,
  createPenaltyCommand,
  normalizeDgLabConfig,
  waveformPayload
} from "../src/dglab/index.ts";
import type { DgLabPenaltyEvent, DgLabTransport, DgLabTransportMessage } from "../src/dglab/index.ts";

class FakeTransport implements DgLabTransport {
  status: "offline" | "connecting" | "waiting-bind" | "paired" | "error" = "offline";
  readonly messages: DgLabTransportMessage[] = [];
  readonly listeners = new Set<(message: DgLabTransportMessage) => void>();
  readonly onStatus: (status: DgLabTransport["status"], clientId: string | null) => void;
  constructor(onStatus: (status: DgLabTransport["status"], clientId: string | null) => void) { this.onStatus = onStatus; }
  connect(): void { this.status = "waiting-bind"; this.onStatus("waiting-bind", "client-1"); }
  close(): void { this.status = "offline"; this.onStatus("offline", null); }
  send(message: DgLabTransportMessage): void { this.messages.push(message); }
  subscribe(listener: (message: DgLabTransportMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  pair(): void { this.status = "paired"; this.onStatus("paired", "client-1"); }
  receive(message: DgLabTransportMessage): void { for (const listener of this.listeners) listener(message); }
}

test("DG-LAB config keeps a local safety ceiling", () => {
  const config = normalizeDgLabConfig({ ...DEFAULT_DGLAB_CONFIG, enabled: true, maxStrength: 200 });
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

test("b2b break is stronger than a one-step combo", () => {
  const breakEvent: DgLabPenaltyEvent = { kind: "b2bBreak", amount: 1, source: "solo" };
  const comboEvent: DgLabPenaltyEvent = { kind: "combo", amount: 1, source: "solo" };
  const broken = createPenaltyCommand(breakEvent, DEFAULT_DGLAB_CONFIG);
  const combo = createPenaltyCommand(comboEvent, DEFAULT_DGLAB_CONFIG);
  assert.ok(broken && combo);
  assert.ok(broken.strength > combo.strength);
  assert.ok(broken.durationMs > combo.durationMs);
});

test("controller exposes pairing and both channel readings", () => {
  let fake: FakeTransport | null = null;
  const controller = new DgLabController({ ...DEFAULT_DGLAB_CONFIG, enabled: true, wsUrl: "ws://relay:9999" }, {
    createTransport: (_url, onStatus) => { fake = new FakeTransport(onStatus); return fake; },
    now: () => 10_000
  });
  controller.connect();
  assert.equal(controller.status.connection, "waiting-bind");
  assert.match(controller.status.pairingUrl ?? "", /DGLAB-SOCKET/);
  fake!.pair();
  assert.equal(controller.arm(), true);
  fake!.receive({ type: "msg", message: "strength-12+7+40+30" });
  assert.deepEqual(controller.status.channels, {
    A: { strength: 12, limit: 40 },
    B: { strength: 7, limit: 30 }
  });
  controller.handleEvent({ kind: "b2bBreak", amount: 1, source: "solo" });
  assert.ok(fake!.messages.some((message) => message.type === "clientMsg"));
  controller.disarm();
  assert.equal(controller.status.armed, false);
  controller.dispose();
});
