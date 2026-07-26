interface GameOverlayProps {
  readonly phase: "idle" | "playing" | "paused" | "ended";
  readonly onStart: () => void;
  readonly onResume: () => void;
  readonly onRestart: () => void;
}

export function GameOverlay({
  phase,
  onStart,
  onResume,
  onRestart
}: GameOverlayProps): React.JSX.Element | null {
  if (phase === "playing") return null;

  const content = {
    idle: {
      eyebrow: "LOCAL SESSION READY",
      title: "单人无限练习",
      body: "使用当前本地键位与 Handling。数据不会离开此设备。",
      action: "开始",
      onAction: onStart
    },
    paused: {
      eyebrow: "SIMULATION PAUSED",
      title: "已暂停",
      body: "固定步进与 Handling 计时均已冻结。",
      action: "继续",
      onAction: onResume
    },
    ended: {
      eyebrow: "SESSION COMPLETE",
      title: "TOP OUT",
      body: "重开会从相同的本地 7-Bag 序列重新开始，方便复盘。",
      action: "再来一局",
      onAction: onRestart
    }
  }[phase];

  return (
    <div className="game-overlay">
      <div className="game-overlay__card">
        <span>{content.eyebrow}</span>
        <h2>{content.title}</h2>
        <p>{content.body}</p>
        <button
          className="button button--primary"
          onClick={content.onAction}
          type="button"
        >
          {content.action}
        </button>
        <a href="/">返回模式选择</a>
      </div>
    </div>
  );
}
