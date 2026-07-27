import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";

import type { PlayerConfig } from "../../config/v3/index.ts";
import type { MatchFeedbackState } from "@tetr-d/protocol";
import type { DgLabPenaltyEvent } from "../../dglab/dglabTypes.ts";
import {
  BROWSER_FRAME_SCHEDULER,
  LatestFramePublisher
} from "../hooks/LatestFramePublisher.ts";
import { DuelRoomSession } from "./DuelRoomSession.ts";
import type {
  DuelRoomActions,
  DuelRoomView,
  EnterRoomInput
} from "./duelTypes.ts";

const EMPTY_VIEW: DuelRoomView = {
  connection: "entry",
  player: null,
  room: null,
  match: null,
  players: [],
  result: null,
  frameAnchor: null,
  feedback: {},
  error: null
};

export function useDuelRoom(
  config: PlayerConfig,
  onPenaltyEvent?: (event: DgLabPenaltyEvent) => void,
  localFeedback?: MatchFeedbackState
): DuelRoomView & DuelRoomActions {
  const initialConfig = useRef(config).current;
  const sessionRef = useRef<DuelRoomSession | null>(null);
  const [view, setView] = useState<DuelRoomView>(EMPTY_VIEW);

  useEffect(() => {
    const session = new DuelRoomSession(initialConfig, onPenaltyEvent);
    const publisher = new LatestFramePublisher(
      setView,
      BROWSER_FRAME_SCHEDULER
    );
    sessionRef.current = session;
    const unsubscribe = session.subscribe((next, source) => {
      if (source === "realtime-snapshot") {
        publisher.enqueue(next);
      } else {
        publisher.publishNow(next);
      }
    });
    void session.resumeSaved();
    return () => {
      unsubscribe();
      publisher.dispose();
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [initialConfig, onPenaltyEvent]);

  useEffect(() => {
    if (localFeedback !== undefined) sessionRef.current?.setLocalFeedback(localFeedback);
  }, [localFeedback]);

  const requireSession = useCallback((): DuelRoomSession => {
    const session = sessionRef.current;
    if (session === null) throw new Error("双人会话尚未初始化。");
    return session;
  }, []);

  const createRoom = useCallback(
    (input: EnterRoomInput) => requireSession().createRoom(input),
    [requireSession]
  );
  const joinRoom = useCallback(
    (input: EnterRoomInput) => requireSession().joinRoom(input),
    [requireSession]
  );
  const setReady = useCallback(
    (ready: boolean) => requireSession().setReady(ready),
    [requireSession]
  );
  const updateSettings = useCallback(
    (patch: Parameters<DuelRoomSession["updateSettings"]>[0]) =>
      requireSession().updateSettings(patch),
    [requireSession]
  );
  const forfeit = useCallback(
    () => requireSession().forfeit(),
    [requireSession]
  );
  const nextRound = useCallback(
    () => requireSession().nextRound(),
    [requireSession]
  );
  const leave = useCallback(
    () => requireSession().leave(),
    [requireSession]
  );

  return {
    ...view,
    createRoom,
    joinRoom,
    setReady,
    updateSettings,
    forfeit,
    nextRound,
    leave
  };
}
