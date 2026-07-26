import { useMemo, useRef } from "react";
import type { MatchFeedbackState } from "@tetr-d/protocol";

import { usePlayerConfig } from "../config/usePlayerConfig.ts";
import { DuelArena } from "../game/components/DuelArena.tsx";
import { DuelEntry } from "../game/components/DuelEntry.tsx";
import { DuelLobby } from "../game/components/DuelLobby.tsx";
import { useDuelRoom } from "../game/duel/useDuelRoom.ts";
import { Brand } from "../ui/Brand.tsx";
import { useDgLabConfig } from "../dglab/useDgLabConfig.ts";
import { useDgLabPenalty } from "../dglab/useDgLabPenalty.ts";

export function DuelPage(): React.JSX.Element {
  const { config } = usePlayerConfig();
  const dglabConfig = useDgLabConfig();
  const dglab = useDgLabPenalty(dglabConfig.config);
  const sessionConfig = useRef(config).current;
  const localFeedback = useMemo<MatchFeedbackState>(() => ({
    visible: dglab.status.connection === "paired",
    connected: dglab.status.connection === "paired",
    armed: dglab.status.armed,
    channelA: dglab.status.channels.A,
    channelB: dglab.status.channels.B
  }), [dglab.status]);
  const duel = useDuelRoom(sessionConfig, dglab.handleEvent, localFeedback);
  const roomCode = new URLSearchParams(window.location.search)
    .get("room")?.toUpperCase() ?? "";

  let content: React.JSX.Element;
  if (duel.room === null || duel.player === null) {
    content = (
      <DuelEntry
        connection={duel.connection}
        error={duel.error}
        initialRoomCode={roomCode}
        onCreate={duel.createRoom}
        onJoin={duel.joinRoom}
      />
    );
  } else if (
    duel.match !== null &&
    duel.frameAnchor !== null &&
    (
      duel.room.phase === "playing" ||
      duel.room.phase === "countdown" ||
      duel.result !== null
    )
  ) {
    content = (
      <DuelArena
        disconnected={duel.connection !== "connected"}
        error={duel.error}
        frameAnchor={duel.frameAnchor}
        match={duel.match}
        onForfeit={duel.forfeit}
        onNextRound={duel.nextRound}
        players={duel.players}
        feedback={duel.feedback}
        dglab={dglab}
        result={duel.result}
        room={duel.room}
        selfPlayerId={duel.player.playerId}
      />
    );
  } else {
    content = (
      <DuelLobby
        error={duel.error}
        onNextRound={duel.nextRound}
        onReady={duel.setReady}
        onSettings={duel.updateSettings}
        room={duel.room}
      />
    );
  }

  return (
    <div className="duel-shell">
      <header className="duel-header">
        <Brand />
        <nav>
          <a href="/config">操作配置</a>
          <a href="/" onClick={() => duel.leave()}>返回首页</a>
        </nav>
      </header>
      {content}
    </div>
  );
}
