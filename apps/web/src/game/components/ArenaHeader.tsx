import { Brand } from "../../ui/Brand";

interface ArenaHeaderProps {
  readonly phase: "idle" | "playing" | "paused" | "ended";
  readonly onPauseToggle: () => void;
  readonly onRestart: () => void;
}

const PHASE_LABELS = {
  idle: "READY",
  playing: "LIVE",
  paused: "PAUSED",
  ended: "TOP OUT"
} as const;

export function ArenaHeader({
  phase,
  onPauseToggle,
  onRestart
}: ArenaHeaderProps): React.JSX.Element {
  const canPause = phase === "playing" || phase === "paused";
  return (
    <header className="arena-header">
      <Brand />
      <div className="arena-header__mode">
        <span>SOLO / ENDLESS</span>
        <strong className={`arena-status arena-status--${phase}`}>
          {PHASE_LABELS[phase]}
        </strong>
      </div>
      <nav className="arena-header__actions" aria-label="单人模式操作">
        <a className="arena-link" href="/config">配置</a>
        <button className="arena-link" onClick={onRestart} type="button">
          重开
        </button>
        <button
          className="arena-link arena-link--primary"
          disabled={!canPause}
          onClick={onPauseToggle}
          type="button"
        >
          {phase === "paused" ? "继续" : "暂停"}
        </button>
      </nav>
    </header>
  );
}
