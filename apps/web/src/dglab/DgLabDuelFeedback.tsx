import type { MatchFeedbackState, PublicPlayer } from "@tetr-d/protocol";

function fillClass(strength: number, limit: number): string {
  if (limit <= 0) return "dglab-duel-feedback__fill dglab-duel-feedback__fill--offline";
  const ratio = Math.min(1, strength / limit);
  return `dglab-duel-feedback__fill ${ratio > .75 ? "dglab-duel-feedback__fill--hot" : ratio > .45 ? "dglab-duel-feedback__fill--warm" : ""}`;
}

function channel(label: string, strength: number, limit: number): React.JSX.Element {
  const ratio = limit > 0 ? Math.min(100, strength / limit * 100) : 0;
  return <div className="dglab-duel-feedback__channel">
    <div><span>{label}</span><strong>{strength}<small> / {limit || "—"}</small></strong></div>
    <div className="dglab-duel-feedback__track"><span className={fillClass(strength, limit)} style={{ width: `${ratio}%` }} /></div>
  </div>;
}

export function DgLabDuelFeedback({
  players,
  feedback,
  selfPlayerId
}: {
  readonly players: readonly PublicPlayer[];
  readonly feedback: Readonly<Record<string, MatchFeedbackState>>;
  readonly selfPlayerId: string;
}): React.JSX.Element {
  return <section className="dglab-duel-feedback" aria-label="DG-LAB 对局强度">
    <header className="dglab-duel-feedback__header">
      <span>DG-LAB / LIVE INTENSITY</span>
      <small>仅同步当前强度，不同步设备、波形或配置</small>
    </header>
    <div className="dglab-duel-feedback__players">
      {players.map((player) => {
        const state = feedback[player.playerId];
        const connected = state?.connected === true && state.visible;
        const label = state === undefined || !state.visible
          ? "NOT SHARED"
          : state.armed ? "ARMED" : connected ? "SAFE" : "OFFLINE";
        return <article className={`dglab-duel-feedback__player ${player.playerId === selfPlayerId ? "dglab-duel-feedback__player--self" : ""}`} key={player.playerId}>
          <div className="dglab-duel-feedback__player-header"><strong>{player.displayName}</strong><span>{label}</span></div>
          <div className="dglab-duel-feedback__channels">
            {channel("A", state?.channelA.strength ?? 0, state?.channelA.limit ?? 0)}
            {channel("B", state?.channelB.strength ?? 0, state?.channelB.limit ?? 0)}
          </div>
        </article>;
      })}
    </div>
  </section>;
}
