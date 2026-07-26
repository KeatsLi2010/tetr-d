import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";

import type { PlayerConfig } from "../../config/v3/index.ts";
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
  error: null
};

export function useDuelRoom(
  config: PlayerConfig
): DuelRoomView & DuelRoomActions {
  const initialConfig = useRef(config).current;
  const sessionRef = useRef<DuelRoomSession | null>(null);
  const [view, setView] = useState<DuelRoomView>(EMPTY_VIEW);

  useEffect(() => {
    const session = new DuelRoomSession(initialConfig);
    sessionRef.current = session;
    const unsubscribe = session.subscribe(setView);
    void session.resumeSaved();
    return () => {
      unsubscribe();
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [initialConfig]);

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
