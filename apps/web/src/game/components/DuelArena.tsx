import type { RoomStatePayload } from "@tetr-d/protocol";

import type {
  MatchEndMessage,
  MatchStartMessage
} from "../duel/duelTypes.ts";
import type { ServerFrameAnchor } from "../duel/garbagePreviewModel.ts";
import type { NetworkPlayerState } from "../duel/networkPlayerState.ts";
import { PlayerWell } from "./PlayerWell.tsx";
import { DgLabControlPanel } from "../../dglab/DgLabControlPanel.tsx";
import { DgLabDuelFeedback } from "../../dglab/DgLabDuelFeedback.tsx";
import type { DgLabPenaltyState } from "../../dglab/useDgLabPenalty.ts";
import type { MatchFeedbackState } from "@tetr-d/protocol";

export interface DuelArenaProps {
  readonly selfPlayerId: string;
  readonly room: RoomStatePayload;
  readonly match: MatchStartMessage;
  readonly players: readonly NetworkPlayerState[];
  readonly frameAnchor: ServerFrameAnchor;
  readonly result: MatchEndMessage | null;
  readonly disconnected: boolean;
  readonly error: string | null;
  readonly onForfeit: () => void;
  readonly onNextRound: () => void;
  readonly dglab?: DgLabPenaltyState;
  readonly feedback: Readonly<Record<string, MatchFeedbackState>>;
}

export function DuelArena({
  selfPlayerId,
  room,
  match,
  players,
  frameAnchor,
  result,
  disconnected,
  error,
  onForfeit,
  onNextRound,
  dglab,
  feedback
}: DuelArenaProps): React.JSX.Element {
  const wins = room.series?.wins ?? [0, 0];
  const canContinue =
    room.phase === "between_games" ||
    room.phase === "series_complete";
  const won = result?.winnerPlayerId === selfPlayerId;

  return (
    <main
      className="duel-arena"
      data-duel-phase={result === null ? "playing" : "ended"}
    >
      <header className="duel-arena__status">
        <div>
          <span>ROOM {room.roomCode}</span>
          <strong>{wins[0]} : {wins[1]}</strong>
        </div>
        <div className="duel-arena__status-actions">
          <span>{match.simulationHz}HZ / SERVER</span>
          <button
            className="button"
            disabled={result !== null}
            onClick={onForfeit}
            type="button"
          >
            认输
          </button>
        </div>
      </header>

      {dglab !== undefined && <DgLabControlPanel penalty={dglab} />}
      <DgLabDuelFeedback
        feedback={feedback}
        players={match.players}
        selfPlayerId={selfPlayerId}
      />

      <section className="duel-arena__boards">
        {match.players.map((identity, seat) => {
          const state = players.find(
            (candidate) => candidate.playerId === identity.playerId
          );
          if (state === undefined) {
            return (
              <div className="duel-board-loading" key={identity.playerId}>
                正在同步 {identity.displayName}…
              </div>
            );
          }
          const isSelf = identity.playerId === selfPlayerId;
          const connected = room.seats[seat]?.connected ?? true;
          const finishedLabel = result?.winnerPlayerId === null
            ? "DRAW"
            : result?.winnerPlayerId === identity.playerId ? "WIN" : "LOSS";
          return (
            <PlayerWell
              className={isSelf ? "player-well--self" : ""}
              garbageClock={{
                frameAnchor,
                simulationHz: match.simulationHz,
                travelFrames: match.garbageTravelFrames
              }}
              key={identity.playerId}
              modeLabel={isSelf ? `YOU / P${seat + 1}` : `RIVAL / P${seat + 1}`}
              phase={!connected ? "paused" : result === null ? "playing" : "ended"}
              playerName={identity.displayName}
              statusLabel={
                !connected ? "RECONNECTING" : result === null ? undefined : finishedLabel
              }
              view={state}
            />
          );
        })}
      </section>

      {error !== null && (
        <p className="duel-arena__error" role="alert">{error}</p>
      )}
      {(result !== null || disconnected) && (
        <div className="duel-result-overlay">
          <div className="duel-result-card">
            <span>{disconnected ? "RECONNECTING" : "ROUND COMPLETE"}</span>
            <h2>
              {disconnected
                ? "连接中断"
                : result?.winnerPlayerId === null
                  ? "平局"
                  : won ? "胜利" : "失败"}
            </h2>
            <p>
              {disconnected
                ? "服务器仍在继续比赛，正在使用轮换令牌恢复会话。"
                : `本局原因：${result?.reason ?? "unknown"}`}
            </p>
            {result !== null && (
              <button
                className="button button--primary"
                data-action="next-round"
                disabled={!canContinue}
                onClick={onNextRound}
                type="button"
              >
                {room.phase === "series_complete" ? "同意再战" : "准备下一局"}
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
