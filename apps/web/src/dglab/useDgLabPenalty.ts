import { useCallback, useEffect, useRef, useState } from "react";

import { DgLabController } from "./dglabController.ts";
import type { DgLabConfig, DgLabPenaltyEvent, DgLabStatus } from "./dglabTypes.ts";

export interface DgLabPenaltyState {
  readonly status: DgLabStatus;
  readonly enabled: boolean;
  readonly connect: (forceChooser?: boolean) => void;
  readonly disconnect: () => void;
  readonly arm: () => boolean;
  readonly disarm: () => void;
  readonly test: () => boolean;
  readonly handleEvent: (event: DgLabPenaltyEvent) => void;
}

export function useDgLabPenalty(config: DgLabConfig): DgLabPenaltyState {
  const controllerRef = useRef<DgLabController | null>(null);
  if (controllerRef.current === null) controllerRef.current = new DgLabController(config);
  const controller = controllerRef.current;
  const [status, setStatus] = useState<DgLabStatus>(controller.status);

  useEffect(() => {
    controller.updateConfig(config);
  }, [config, controller]);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setStatus);
    const stop = (): void => controller.disarm();
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", stop);
    return () => {
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", stop);
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  return {
    status,
    enabled: config.enabled,
    connect: useCallback((forceChooser?: boolean) => controller.connect(forceChooser), [controller]),
    disconnect: useCallback(() => controller.disconnect(), [controller]),
    arm: useCallback(() => controller.arm(), [controller]),
    disarm: useCallback(() => controller.disarm(), [controller]),
    test: useCallback(() => controller.test(), [controller]),
    handleEvent: useCallback((event: DgLabPenaltyEvent) => controller.handleEvent(event), [controller])
  };
}
