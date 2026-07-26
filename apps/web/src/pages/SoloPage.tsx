import { useRef } from "react";

import { usePlayerConfig } from "../config/usePlayerConfig";
import { ArenaHeader } from "../game/components/ArenaHeader";
import { GameHud } from "../game/components/GameHud";
import { GameOverlay } from "../game/components/GameOverlay";
import { PlayerWell } from "../game/components/PlayerWell";
import { useSoloGame } from "../game/hooks/useSoloGame";

export function SoloPage(): React.JSX.Element {
  const { config } = usePlayerConfig();
  const sessionConfig = useRef(config).current;
  const game = useSoloGame(sessionConfig);
  const snapshot = game.snapshot;

  if (snapshot === null) {
    return (
      <div className="arena-shell arena-loading" role="status">
        正在准备本地 240Hz 会话…
      </div>
    );
  }

  const { player, stats, phase } = snapshot;
  return (
    <div className="arena-shell">
      <ArenaHeader
        phase={phase}
        onPauseToggle={game.pauseToggle}
        onRestart={game.restart}
      />
      <main className="arena-main">
        <GameHud
          {...stats}
          combo={player.combo}
          backToBack={player.backToBack}
        />
        <div className="arena-board-region">
          <PlayerWell
            view={player}
            phase={phase}
            playerName="YOU"
            modeLabel={`LOCAL · ${snapshot.tickRateHz}HZ`}
          />
          <GameOverlay
            phase={phase}
            onStart={game.start}
            onResume={game.resume}
            onRestart={game.restart}
          />
        </div>
      </main>
    </div>
  );
}
