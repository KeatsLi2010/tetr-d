import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_DGLAB_CONFIG,
  DGLAB_CONFIG_STORAGE_KEY,
  loadDgLabConfig,
  normalizeDgLabConfig,
  resetDgLabConfig,
  saveDgLabConfig
} from "./dglabConfig.ts";
import type { DgLabConfig } from "./dglabTypes.ts";

export interface DgLabConfigState {
  readonly config: DgLabConfig;
  readonly saveState: "saved" | "saving" | "error";
  readonly update: (recipe: (current: DgLabConfig) => DgLabConfig) => void;
  readonly reset: () => void;
}

function initialConfig(): DgLabConfig {
  if (typeof window === "undefined") return DEFAULT_DGLAB_CONFIG;
  return loadDgLabConfig(window.localStorage);
}

export function useDgLabConfig(): DgLabConfigState {
  const [config, setConfig] = useState<DgLabConfig>(initialConfig);
  const [saveState, setSaveState] = useState<DgLabConfigState["saveState"]>("saved");

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      setSaveState(saveDgLabConfig(window.localStorage, config) ? "saved" : "error");
    }, 80);
    return () => window.clearTimeout(timer);
  }, [config]);

  useEffect(() => {
    const receiveStorage = (event: StorageEvent): void => {
      if (event.storageArea !== window.localStorage || event.key !== DGLAB_CONFIG_STORAGE_KEY || event.newValue === null) return;
      try {
        const next = normalizeDgLabConfig(JSON.parse(event.newValue));
        if (next !== null) setConfig(next);
      } catch { /* ignore another tab's malformed value */ }
    };
    window.addEventListener("storage", receiveStorage);
    return () => window.removeEventListener("storage", receiveStorage);
  }, []);

  const update = useCallback((recipe: (current: DgLabConfig) => DgLabConfig): void => {
    setConfig((current) => {
      const next = normalizeDgLabConfig(recipe(current));
      if (next === null) throw new TypeError("Invalid DG-LAB config update.");
      return next;
    });
  }, []);
  const reset = useCallback(() => {
    setConfig(resetDgLabConfig(window.localStorage));
    setSaveState("saved");
  }, []);
  return { config, saveState, update, reset };
}

