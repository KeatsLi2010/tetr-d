import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PLAYER_CONFIG } from "../src/config/v3/index.ts";
import {
  HANDLING_PRESETS,
  activeHandlingPreset
} from "../src/settings/handlingPresets.ts";

test("controlled preset matches the supplied handling profile", () => {
  const preset = HANDLING_PRESETS.find(({ id }) => id === "controlled");
  assert.ok(preset);
  assert.deepEqual(preset.values, {
    arrFrameTenths: 13,
    dasFrameTenths: 60,
    dcdFrameTenths: 105,
    sdf: "sonic",
    dasCancellation: false,
    safeLock: true,
    preferSoftDrop: true
  });

  const handling = {
    ...DEFAULT_PLAYER_CONFIG.handling,
    ...preset.values
  };
  assert.equal(activeHandlingPreset(handling), "controlled");
  assert.equal(
    activeHandlingPreset({ ...handling, preferSoftDrop: false }),
    "custom"
  );
});
