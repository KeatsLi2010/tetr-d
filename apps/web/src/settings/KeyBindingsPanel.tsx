import { useCallback, useMemo, useState } from "react";

import {
  bindingConflicts,
  type PlayerActionName,
  type PlayerConfig,
  type PlayerKeyBindings
} from "../config/v3/index.ts";
import {
  PLAYER_ACTION_LABELS_ZH,
  displayKeyCode
} from "../input/public.ts";
import { KeyCaptureDialog } from "./KeyCaptureDialog";
import {
  GUIDELINE_BINDINGS,
  WASD_BINDINGS,
  activeBindingPreset,
  type BindingPreset
} from "./keybindingPresets";

interface KeyBindingsPanelProps {
  readonly config: PlayerConfig;
  readonly onChange: (bindings: PlayerKeyBindings) => void;
}

interface CaptureTarget {
  readonly action: PlayerActionName;
  readonly slot: number;
}

const groups: readonly {
  readonly label: string;
  readonly actions: readonly PlayerActionName[];
}[] = [
  {
    label: "移动与落下",
    actions: ["moveLeft", "moveRight", "softDrop", "hardDrop"]
  },
  {
    label: "旋转与暂存",
    actions: ["rotateCCW", "rotateCW", "rotate180", "hold"]
  },
  {
    label: "对局操作",
    actions: ["forfeit", "retry", "openChat"]
  }
];

const actionDescriptions: Readonly<Record<PlayerActionName, string>> = {
  moveLeft: "立即左移一格；长按由本地 DAS / ARR 展开",
  moveRight: "立即右移一格；长按由本地 DAS / ARR 展开",
  softDrop: "按本地 SDF 下移，不会直接锁定",
  hardDrop: "落到底部并立即锁定",
  rotateCW: "使用 SRS+ 顺时针旋转",
  rotateCCW: "使用 SRS+ 逆时针旋转",
  rotate180: "使用 SRS+ 180° 旋转",
  hold: "交换暂存方块",
  forfeit: "主动结束当前对局",
  retry: "结算后准备下一局",
  openChat: "打开房间聊天输入框"
};

function withBinding(
  bindings: PlayerKeyBindings,
  target: CaptureTarget,
  code: string | null
): PlayerKeyBindings {
  const current = [...bindings[target.action]];
  if (code === null) {
    current.splice(target.slot, 1);
  } else {
    const duplicate = current.indexOf(code);
    if (duplicate >= 0) current.splice(duplicate, 1);
    current[target.slot] = code;
  }
  return Object.freeze({
    ...bindings,
    [target.action]: Object.freeze(current.filter(Boolean).slice(0, 3))
  });
}

export function KeyBindingsPanel({
  config,
  onChange
}: KeyBindingsPanelProps): React.JSX.Element {
  const [capture, setCapture] = useState<CaptureTarget | null>(null);
  const conflicts = useMemo(
    () => bindingConflicts(config.bindings),
    [config.bindings]
  );
  const preset = activeBindingPreset(config);

  const finishCapture = useCallback((code: string | null) => {
    setCapture((target) => {
      if (target !== null) {
        onChange(withBinding(config.bindings, target, code));
      }
      return null;
    });
  }, [config.bindings, onChange]);

  const choosePreset = (next: BindingPreset): void => {
    if (next === "guideline") onChange(GUIDELINE_BINDINGS);
    if (next === "wasd") onChange(WASD_BINDINGS);
  };

  return (
    <>
      <section className="panel" id="controls">
        <div className="panel__header">
          <div>
            <h2 className="panel__title">键盘绑定</h2>
            <p className="panel__description">
              使用物理键码；切换键盘布局不会改变绑定位置
            </p>
          </div>
          <div className="segmented" aria-label="键位方案">
            {(["guideline", "wasd", "custom"] as const).map((item) => (
              <button
                aria-pressed={preset === item}
                disabled={item === "custom" && preset !== "custom"}
                key={item}
                onClick={() => choosePreset(item)}
                type="button"
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        <div className="binding-groups">
          {groups.map((group) => (
            <div className="binding-group" key={group.label}>
              <div className="binding-group__label">{group.label}</div>
              {group.actions.map((action) => (
                <div className="binding-row" key={action}>
                  <div>
                    <span className="binding-row__title">
                      {PLAYER_ACTION_LABELS_ZH[action]}
                    </span>
                    <span className="binding-row__description">
                      {actionDescriptions[action]}
                    </span>
                  </div>
                  <div className="key-slots">
                    {[0, 1, 2].map((slot) => {
                      const code = config.bindings[action][slot];
                      const listening =
                        capture?.action === action && capture.slot === slot;
                      const conflict =
                        code !== undefined && conflicts.has(code);
                      return (
                        <button
                          aria-label={`${PLAYER_ACTION_LABELS_ZH[action]}绑定 ${
                            slot + 1
                          }`}
                          className={[
                            "keycap",
                            code === undefined ? "keycap--empty" : "",
                            conflict ? "keycap--conflict" : "",
                            listening ? "keycap--listening" : ""
                          ].filter(Boolean).join(" ")}
                          key={slot}
                          onClick={() => setCapture({ action, slot })}
                          type="button"
                        >
                          {listening
                            ? "正在监听…"
                            : code === undefined
                              ? "点击绑定"
                              : displayKeyCode(code)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        {conflicts.size > 0 && (
          <div className="conflict-note" role="status">
            <span aria-hidden="true">△</span>
            <span>
              检测到 {conflicts.size} 个重复键位。本站允许保留冲突；
              对局中会按上方稳定顺序同时触发对应动作。
            </span>
          </div>
        )}
      </section>
      {capture !== null && (
        <KeyCaptureDialog
          actionLabel={PLAYER_ACTION_LABELS_ZH[capture.action]}
          onCancel={() => setCapture(null)}
          onCapture={finishCapture}
        />
      )}
    </>
  );
}
