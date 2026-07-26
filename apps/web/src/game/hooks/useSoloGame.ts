import { useCallback, useEffect, useRef, useState } from "react";
import type { SevenBagSeed } from "@tetr-d/game-core";

import type { PlayerConfig } from "../../config/v3/index.ts";
import type { GameSessionSnapshot } from "../sessionTypes.ts";
import {
  GameHandlingController,
  type GameInputCommand
} from "../input/GameHandlingController.ts";
import { SoloGameSession } from "../solo/index.ts";

interface SoloGameBundle {
  readonly controller: GameHandlingController;
  readonly session: SoloGameSession;
}

export interface SoloGameState {
  readonly snapshot: GameSessionSnapshot | null;
  readonly start: () => void;
  readonly pauseToggle: () => void;
  readonly resume: () => void;
  readonly restart: () => void;
}

function makeSeed(): SevenBagSeed {
  const words = new Uint32Array(4);
  globalThis.crypto.getRandomValues(words);
  if (words.every((word) => word === 0)) words[0] = 1;
  return [words[0]!, words[1]!, words[2]!, words[3]!];
}

function monotonicNow(): number {
  return globalThis.performance.now();
}

function configuredCodes(config: PlayerConfig): ReadonlySet<string> {
  return new Set(Object.values(config.bindings).flat());
}

export function useSoloGame(config: PlayerConfig): SoloGameState {
  const bundleRef = useRef<SoloGameBundle | null>(null);
  const [snapshot, setSnapshot] = useState<GameSessionSnapshot | null>(null);

  useEffect(() => {
    const startTimeMs = monotonicNow();
    const controller = new GameHandlingController(config, { startTimeMs });
    const session = new SoloGameSession({
      seed: makeSeed(),
      now: monotonicNow,
      actionsForTick: (tickTimeMs) =>
        controller.actionsForTick(tickTimeMs),
      onPieceSpawned: (atMs, _frame, cause) => {
        controller.notifyPieceSpawned(atMs, cause);
      },
      onClockReanchored: (atMs) => controller.clear(atMs)
    });
    const bundle = { controller, session };
    const allCodes = configuredCodes(config);
    const pauseCodes = new Set(config.bindings.forfeit);
    const retryCodes = new Set(config.bindings.retry);
    bundleRef.current = bundle;
    setSnapshot(session.snapshot);

    const unsubscribe = session.subscribe(setSnapshot);
    let animationFrame = 0;

    const pause = (atMs: number): void => {
      if (session.snapshot.phase !== "playing") return;
      session.advanceTo(atMs);
      controller.clear(atMs);
      session.pause();
    };

    const restart = (atMs: number): void => {
      controller.clear(atMs);
      session.restart();
    };

    const runCommands = (
      commands: readonly GameInputCommand[],
      atMs: number
    ): void => {
      for (const command of commands) {
        if (command === "forfeit") {
          pause(atMs);
          return;
        }
        if (command === "retry") {
          restart(atMs);
          return;
        }
      }
    };

    const keyDown = (event: KeyboardEvent): void => {
      if (!allCodes.has(event.code)) return;
      const atMs = monotonicNow();
      const phase = session.snapshot.phase;

      if (phase === "paused" && pauseCodes.has(event.code)) {
        event.preventDefault();
        if (!event.repeat) {
          controller.clear(atMs);
          session.resume();
        }
        return;
      }
      if (
        phase !== "playing" &&
        retryCodes.has(event.code)
      ) {
        event.preventDefault();
        if (!event.repeat) restart(atMs);
        return;
      }
      if (phase !== "playing") return;

      event.preventDefault();
      session.advanceTo(atMs);
      if (session.snapshot.phase !== "playing") return;
      runCommands(controller.keyDown({
        code: event.code,
        atMs,
        repeat: event.repeat
      }), atMs);
    };

    const keyUp = (event: KeyboardEvent): void => {
      if (
        !allCodes.has(event.code) ||
        session.snapshot.phase !== "playing"
      ) {
        return;
      }
      event.preventDefault();
      const atMs = monotonicNow();
      session.advanceTo(atMs);
      if (session.snapshot.phase !== "playing") return;
      runCommands(controller.keyUp({ code: event.code, atMs }), atMs);
    };

    const pauseForLostFocus = (): void => {
      pause(monotonicNow());
    };

    const visibilityChanged = (): void => {
      if (document.visibilityState === "hidden") pauseForLostFocus();
    };

    const renderLoop = (): void => {
      session.advanceTo(monotonicNow());
      animationFrame = window.requestAnimationFrame(renderLoop);
    };

    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", pauseForLostFocus);
    document.addEventListener("visibilitychange", visibilityChanged);
    animationFrame = window.requestAnimationFrame(renderLoop);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", pauseForLostFocus);
      document.removeEventListener("visibilitychange", visibilityChanged);
      unsubscribe();
      session.dispose();
      if (bundleRef.current === bundle) bundleRef.current = null;
    };
  }, [config]);

  const start = useCallback(() => {
    const bundle = bundleRef.current;
    if (bundle === null) return;
    const atMs = monotonicNow();
    bundle.controller.clear(atMs);
    bundle.session.start();
  }, []);

  const resume = useCallback(() => {
    const bundle = bundleRef.current;
    if (bundle === null || bundle.session.snapshot.phase !== "paused") return;
    const atMs = monotonicNow();
    bundle.controller.clear(atMs);
    bundle.session.resume();
  }, []);

  const pauseToggle = useCallback(() => {
    const bundle = bundleRef.current;
    if (bundle === null) return;
    const atMs = monotonicNow();
    if (bundle.session.snapshot.phase === "paused") {
      bundle.controller.clear(atMs);
      bundle.session.resume();
      return;
    }
    if (bundle.session.snapshot.phase !== "playing") return;
    bundle.session.advanceTo(atMs);
    bundle.controller.clear(atMs);
    bundle.session.pause();
  }, []);

  const restart = useCallback(() => {
    const bundle = bundleRef.current;
    if (bundle === null) return;
    const atMs = monotonicNow();
    bundle.controller.clear(atMs);
    bundle.session.restart();
  }, []);

  return { snapshot, start, pauseToggle, resume, restart };
}
