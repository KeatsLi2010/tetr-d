interface GameHudProps {
  readonly elapsedMs: number;
  readonly lines: number;
  readonly pieces: number;
  readonly attack: number;
  readonly pps: number;
  readonly apm: number;
  readonly combo: number;
  readonly backToBack: number;
}

function clockLabel(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${
    seconds.toString().padStart(2, "0")
  }`;
}

export function GameHud({
  elapsedMs,
  lines,
  pieces,
  attack,
  pps,
  apm,
  combo,
  backToBack
}: GameHudProps): React.JSX.Element {
  return (
    <aside className="game-hud" aria-label="本局统计">
      <div className="game-hud__eyebrow">LIVE METRICS</div>
      <div className="game-hud__primary">
        <div><strong>{clockLabel(elapsedMs)}</strong><span>TIME</span></div>
        <div><strong>{lines}</strong><span>LINES</span></div>
      </div>
      <div className="game-hud__grid">
        <div><strong>{pieces}</strong><span>PIECES</span></div>
        <div><strong>{attack}</strong><span>ATTACK</span></div>
        <div><strong>{pps.toFixed(2)}</strong><span>PPS</span></div>
        <div><strong>{apm.toFixed(1)}</strong><span>APM</span></div>
      </div>
      <div className="game-hud__streaks">
        <span>COMBO <strong>{Math.max(0, combo)}</strong></span>
        <span>B2B <strong>{backToBack}</strong></span>
      </div>
      <p>
        当前为完全本地的无限练习；规则层与未来房间比赛共用。
      </p>
    </aside>
  );
}
