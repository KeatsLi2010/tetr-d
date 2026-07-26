import { useEffect, useState } from "react";
import type { RoomStatePayload } from "@tetr-d/protocol";
import type { RoomSettings } from "@tetr-d/room-core";

const TARGET_WINS = [1, 2, 3, 5] as const;

export interface DuelLobbyProps {
  readonly room: RoomStatePayload;
  readonly error: string | null;
  readonly onReady: (ready: boolean) => void;
  readonly onSettings: (patch: Partial<RoomSettings>) => void;
  readonly onNextRound: () => void;
}

function useCountdown(startsAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startsAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [startsAt]);
  if (startsAt === null) return null;
  return Math.max(0, Math.ceil((startsAt - now) / 1_000));
}

export function DuelLobby({
  room,
  error,
  onReady,
  onSettings,
  onNextRound
}: DuelLobbyProps): React.JSX.Element {
  const selfSeat = room.self.seat;
  const self = selfSeat === null ? null : room.seats[selfSeat];
  const votingRematch = room.phase === "series_complete";
  const countdown = useCountdown(
    room.countdown?.startsAtServerTime ?? null
  );
  const inviteUrl = new URL("/play/duel", window.location.origin);
  inviteUrl.searchParams.set("room", room.roomCode);

  return (
    <main className="duel-lobby">
      <header className="duel-lobby__header">
        <div>
          <span>PRIVATE DUEL ROOM</span>
          <h1 data-room-code={room.roomCode}>{room.roomCode}</h1>
        </div>
        <button
          className="button"
          onClick={() => void navigator.clipboard?.writeText(
            inviteUrl.toString()
          )}
          type="button"
        >
          复制邀请链接
        </button>
      </header>

      <section className="duel-lobby__seats">
        {room.seats.map((seat, index) => (
          <article
            className={[
              "duel-seat",
              seat?.playerId === room.self.playerId ? "duel-seat--self" : ""
            ].filter(Boolean).join(" ")}
            key={index}
          >
            <span>PLAYER {index + 1}</span>
            <strong>{seat?.displayName ?? "等待玩家…"}</strong>
            <small>
              {seat === null
                ? "EMPTY"
                : votingRematch
                  ? seat.rematchAccepted ? "REMATCH READY" : "WAITING VOTE"
                : !seat.connected
                  ? "RECONNECTING"
                  : seat.ready
                    ? "READY"
                    : "NOT READY"}
            </small>
          </article>
        ))}
      </section>

      <section className="duel-lobby__controls">
        <label>
          <span>先胜局数</span>
          <select
            disabled={!room.self.permissions.editSettings}
            onChange={(event) => onSettings({
              targetWins: Number(event.target.value) as
                RoomSettings["targetWins"]
            })}
            value={room.settings.targetWins}
          >
            {TARGET_WINS.map((wins) => (
              <option key={wins} value={wins}>{wins}</option>
            ))}
          </select>
        </label>
        <button
          className="button button--primary"
          data-action="ready"
          disabled={
            self === null ||
            (votingRematch
              ? !room.self.permissions.voteRematch || self.rematchAccepted
              : !room.self.permissions.ready)
          }
          onClick={() => {
            if (votingRematch) onNextRound();
            else onReady(!(self?.ready ?? false));
          }}
          type="button"
        >
          {votingRematch
            ? self?.rematchAccepted ? "已同意再战" : "同意再战"
            : self?.ready ? "取消准备" : "准备"}
        </button>
      </section>

      {countdown !== null && (
        <div className="duel-countdown" role="status">
          <span>MATCH START</span>
          <strong>{countdown}</strong>
        </div>
      )}
      {error !== null && <p className="duel-error" role="alert">{error}</p>}
    </main>
  );
}
