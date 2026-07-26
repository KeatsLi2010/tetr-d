import { Brand } from "../ui/Brand";
import { Icon } from "../ui/Icon";

interface AppHeaderProps {
  readonly saveState: "saved" | "saving" | "error";
}

const stateLabels = {
  saved: "已保存在本机",
  saving: "正在保存",
  error: "保存失败"
} as const;

export function AppHeader({ saveState }: AppHeaderProps): React.JSX.Element {
  return (
    <header className="topbar">
      <Brand />
      <div className="topbar__crumb">CONFIGURATION / PLAYER INPUT</div>
      <div className="topbar__status">
        <span className={`local-badge local-badge--${saveState}`}>
          <span>{stateLabels[saveState]}</span>
        </span>
        <a
          aria-label="返回首页"
          className="icon-button"
          href="/"
        >
          <Icon name="chevron" />
        </a>
      </div>
    </header>
  );
}
