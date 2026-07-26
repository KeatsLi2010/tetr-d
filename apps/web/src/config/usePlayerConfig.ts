import { useCallback, useEffect, useRef, useState } from "react";

import {
  DEFAULT_PLAYER_CONFIG,
  loadLocalConfig,
  normalizePlayerConfig,
  PLAYER_CONFIG_STORAGE_KEY,
  resetLocalConfig,
  saveLocalConfig,
  type PlayerConfig
} from "./v3/index.ts";

export type ConfigSaveState = "saved" | "saving" | "error";

export interface PlayerConfigState {
  readonly config: PlayerConfig;
  readonly saveState: ConfigSaveState;
  readonly replace: (config: PlayerConfig) => void;
  readonly update: (recipe: (config: PlayerConfig) => PlayerConfig) => void;
  readonly reset: () => void;
}

function initialConfig(): PlayerConfig {
  if (typeof window === "undefined") return DEFAULT_PLAYER_CONFIG;
  return loadLocalConfig(window.localStorage).config;
}

export function usePlayerConfig(): PlayerConfigState {
  const [config, setConfig] = useState<PlayerConfig>(initialConfig);
  const [saveState, setSaveState] = useState<ConfigSaveState>("saved");
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      setSaveState(
        saveLocalConfig(window.localStorage, config) ? "saved" : "error"
      );
    }, 80);
    return () => window.clearTimeout(timer);
  }, [config]);

  useEffect(() => {
    const receiveStorage = (event: StorageEvent): void => {
      if (
        event.storageArea !== window.localStorage ||
        event.key !== PLAYER_CONFIG_STORAGE_KEY ||
        event.newValue === null
      ) {
        return;
      }
      try {
        const next = normalizePlayerConfig(JSON.parse(event.newValue));
        if (next !== null) setConfig(next);
      } catch {
        // Ignore invalid writes from another tab.
      }
    };
    window.addEventListener("storage", receiveStorage);
    return () => window.removeEventListener("storage", receiveStorage);
  }, []);

  const replace = useCallback((next: PlayerConfig) => {
    const normalized = normalizePlayerConfig(next);
    if (normalized === null) throw new TypeError("Invalid player config.");
    setConfig(normalized);
  }, []);

  const update = useCallback(
    (recipe: (current: PlayerConfig) => PlayerConfig) => {
      setConfig((current) => {
        const next = normalizePlayerConfig(recipe(current));
        if (next === null) throw new TypeError("Invalid player config update.");
        return next;
      });
    },
    []
  );

  const reset = useCallback(() => {
    setConfig(resetLocalConfig(window.localStorage));
    setSaveState("saved");
  }, []);

  return { config, saveState, replace, update, reset };
}
