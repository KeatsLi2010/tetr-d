import type {
  ActivePiece,
  Board,
  PieceKind
} from "@tetr-d/game-core";
import type { PendingGarbagePacket } from "@tetr-d/protocol";

import type { GameSessionPhase } from "../sessionTypes";
import { BoardCanvas } from "./BoardCanvas";
import { PiecePreview } from "./PiecePreview";
import type { ServerFrameAnchor } from "../duel/garbagePreviewModel.ts";
import { GarbagePreviewBar } from "./GarbagePreviewBar.tsx";

export interface PlayerWellView {
  readonly board: Board;
  readonly active: ActivePiece | null;
  readonly hold: PieceKind | null;
  readonly next: readonly PieceKind[];
  readonly pieceCursor: number;
  readonly combo: number;
  readonly backToBack: number;
  readonly piecesPlaced: number;
  readonly totalAttackSent: number;
  readonly pendingGarbage: readonly PendingGarbagePacket[];
  readonly canHold: boolean;
  readonly toppedOut: boolean;
}

export interface PlayerGarbageClock {
  readonly frameAnchor: ServerFrameAnchor;
  readonly simulationHz: number;
  readonly travelFrames: number;
}

export interface PlayerWellProps {
  readonly view: PlayerWellView;
  readonly playerName?: string;
  readonly modeLabel?: string;
  readonly nextCount?: number;
  readonly className?: string;
  readonly phase?: GameSessionPhase;
  readonly statusLabel?: string | undefined;
  readonly garbageClock?: PlayerGarbageClock;
}

const PHASE_LABELS: Readonly<Record<GameSessionPhase, string>> = {
  idle: "READY",
  paused: "PAUSED",
  playing: "RUNNING",
  ended: "TOP OUT"
};

export function PlayerWell({
  view,
  playerName = "PLAYER 1",
  modeLabel = "LOCAL",
  nextCount = 5,
  className = "",
  phase,
  statusLabel,
  garbageClock
}: PlayerWellProps): React.JSX.Element {
  const classes = ["player-well", className].filter(Boolean).join(" ");
  const effectivePhase = phase ?? (view.toppedOut ? "ended" : "playing");
  const phaseLabel = statusLabel ?? PHASE_LABELS[effectivePhase];

  return (
    <section className={classes} aria-label={`${playerName} 游戏区域`}>
      <header className="player-well__header">
        <div>
          <span className="player-well__mode">{modeLabel}</span>
          <h2>{playerName}</h2>
        </div>
        <span
          className={`player-well__state player-well__state--${effectivePhase}`}
          role="status"
          aria-label={`游戏状态：${phaseLabel}`}
        >
          {phaseLabel}
        </span>
      </header>

      <div className="player-well__layout">
        <aside className="player-well__side player-well__side--hold">
          <h3>HOLD</h3>
          <PiecePreview
            kind={view.hold}
            muted={!view.canHold}
            label={view.hold === null ? "Hold 为空" : `Hold ${view.hold}`}
          />
          <div className="player-well__stat player-well__stat--stacked">
            <span>ATTACK</span>
            <strong>{view.totalAttackSent}</strong>
          </div>
        </aside>

        <div
          className={[
            "player-well__field",
            garbageClock === undefined ? "" : "player-well__field--garbage"
          ].filter(Boolean).join(" ")}
        >
          {garbageClock !== undefined && (
            <GarbagePreviewBar
              frameAnchor={garbageClock.frameAnchor}
              packets={view.pendingGarbage}
              playerName={playerName}
              simulationHz={garbageClock.simulationHz}
              travelFrames={garbageClock.travelFrames}
            />
          )}
          <div className="player-well__board-column">
            <BoardCanvas view={view} label={`${playerName} 的棋盘`} />
          </div>
        </div>

        <aside className="player-well__side player-well__side--next">
          <h3>NEXT</h3>
          <div className="player-well__next-list">
            {view.next.slice(0, nextCount).map((kind, index) => (
              <PiecePreview
                kind={kind}
                className={index === 0 ? "piece-preview--primary" : ""}
                key={`${view.pieceCursor}-${index}-${kind}`}
                label={`第 ${index + 1} 个 Next：${kind}`}
              />
            ))}
          </div>
        </aside>
      </div>

      <footer className="player-well__footer">
        <div className="player-well__stat">
          <span>PIECES</span>
          <strong>{view.piecesPlaced}</strong>
        </div>
        <div className="player-well__stat">
          <span>COMBO</span>
          <strong>{Math.max(0, view.combo)}</strong>
        </div>
        <div
          aria-label={`Back-to-back 连击 ${view.backToBack}`}
          className={[
            "player-well__stat",
            "player-well__stat--b2b",
            view.backToBack > 0
              ? "player-well__stat--b2b-active"
              : ""
          ].filter(Boolean).join(" ")}
          data-b2b-active={view.backToBack > 0}
        >
          <span>{view.backToBack > 0 ? "BACK-TO-BACK" : "B2B"}</span>
          <strong>{view.backToBack > 0 ? `×${view.backToBack}` : "0"}</strong>
        </div>
      </footer>
    </section>
  );
}
