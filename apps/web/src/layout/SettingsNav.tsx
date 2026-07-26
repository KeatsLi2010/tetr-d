import { Icon } from "../ui/Icon";

export type SettingsSection = "controls" | "handling" | "dglab";

interface SettingsNavProps {
  readonly active: SettingsSection;
  readonly onSelect: (section: SettingsSection) => void;
}

const items = [
  {
    id: "controls" as const,
    icon: "KB",
    label: "键盘绑定",
    hint: "三槽自定义键位"
  },
  {
    id: "handling" as const,
    icon: "HF",
    label: "操作手感",
    hint: "DAS · ARR · DCD · SDF"
  },
  {
    id: "dglab" as const,
    icon: "DG",
    label: "DG-LAB 反馈",
    hint: "本地配对与安全上限"
  },
];

export function SettingsNav({
  active,
  onSelect
}: SettingsNavProps): React.JSX.Element {
  return (
    <aside className="settings-nav" aria-label="设置分区">
      <div className="settings-nav__eyebrow">PLAYER CONFIG / 01</div>
      <div className="settings-nav__items">
        {items.map((item) => (
          <button
            className={`nav-item ${
              active === item.id ? "nav-item--active" : ""
            }`}
            key={item.id}
            onClick={() => onSelect(item.id)}
            type="button"
          >
            <span className="nav-item__icon">{item.icon}</span>
            <span>
              <span className="nav-item__label">{item.label}</span>
              <span className="nav-item__hint">{item.hint}</span>
            </span>
          </button>
        ))}
        <button className="nav-item" disabled type="button">
          <span className="nav-item__icon">AV</span>
          <span>
            <span className="nav-item__label">画面与声音</span>
            <span className="nav-item__hint">后续阶段开放</span>
          </span>
        </button>
      </div>
      <div className="settings-nav__note">
        <strong>
          <Icon name="check" size={13} /> 只在此设备保存
        </strong>
        配置不会上传到服务器。对局只发送由本机展开后的具体操作。
      </div>
    </aside>
  );
}
