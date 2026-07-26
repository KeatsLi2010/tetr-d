import {
  frameTenthsToMs,
  type BufferMode,
  type PlayerHandlingConfig
} from "../config/v3/index.ts";
import { BufferModeRow } from "./BufferModeRow";
import { HandlingRange } from "./HandlingRange";
import { ToggleRow } from "./ToggleRow";
import {
  HANDLING_PRESETS,
  activeHandlingPreset
} from "./handlingPresets";

interface HandlingPanelProps {
  readonly handling: PlayerHandlingConfig;
  readonly onChange: (handling: PlayerHandlingConfig) => void;
}

function frameLabel(value: number): string {
  return `${(value / 10).toFixed(1)}F`;
}

function msLabel(value: number): string {
  return `${frameTenthsToMs(value).toFixed(1)}ms`;
}

export function HandlingPanel({
  handling,
  onChange
}: HandlingPanelProps): React.JSX.Element {
  const set = <Key extends keyof PlayerHandlingConfig>(
    key: Key,
    value: PlayerHandlingConfig[Key]
  ): void => onChange({ ...handling, [key]: value });
  const activePreset = activeHandlingPreset(handling);
  const sdfSlider = handling.sdf === "sonic" ? 41 : handling.sdf;

  return (
    <>
      <section className="panel" id="handling">
        <div className="panel__header">
          <div>
            <h2 className="panel__title">操作手感</h2>
            <p className="panel__description">
              F 均指 60Hz 参考帧；本机按 240Hz 展开为离散操作
            </p>
          </div>
          <div className="handling-presets" aria-label="操作手感预设">
            {HANDLING_PRESETS.map((preset) => (
              <button
                className={`preset-chip ${
                  activePreset === preset.id ? "preset-chip--active" : ""
                }`}
                key={preset.id}
                onClick={() => onChange({ ...handling, ...preset.values })}
                type="button"
              >
                {preset.label}
              </button>
            ))}
            {activePreset === "custom" && (
              <span className="preset-chip preset-chip--active">自定义</span>
            )}
          </div>
        </div>
        <div className="handling-list">
          <div className="handling-row">
            <div className="handling-row__symbol">DAS</div>
            <div>
              <div className="handling-row__title">
                重复延迟
                <span className="handling-row__name">DELAYED AUTO SHIFT</span>
              </div>
              <p className="handling-row__help">
                首次横移后，长按多久才开始自动移动。
              </p>
            </div>
            <HandlingRange
              ariaLabel="DAS 重复延迟"
              leftLabel="1F · 灵敏"
              max={200}
              min={10}
              onChange={(value) => set("dasFrameTenths", value)}
              primary={frameLabel(handling.dasFrameTenths)}
              secondary={msLabel(handling.dasFrameTenths)}
              rightLabel="20F · 稳定"
              value={handling.dasFrameTenths}
            />
          </div>
          <div className="handling-row">
            <div className="handling-row__symbol">ARR</div>
            <div>
              <div className="handling-row__title">
                横移间隔
                <span className="handling-row__name">AUTO REPEAT RATE</span>
              </div>
              <p className="handling-row__help">
                DAS 充满后每次横移的间隔；0F 会直接移到墙边。
              </p>
            </div>
            <HandlingRange
              ariaLabel="ARR 横移间隔"
              leftLabel="0F · 贴墙"
              max={50}
              min={0}
              onChange={(value) => set("arrFrameTenths", value)}
              primary={frameLabel(handling.arrFrameTenths)}
              secondary={
                handling.arrFrameTenths === 0
                  ? "瞬时贴墙"
                  : `${msLabel(handling.arrFrameTenths)} / 格`
              }
              rightLabel="5F · 逐格"
              value={handling.arrFrameTenths}
            />
          </div>
          <div className="handling-row">
            <div className="handling-row__symbol">DCD</div>
            <div>
              <div className="handling-row__title">
                DAS 截断延迟
                <span className="handling-row__name">DAS CUT DELAY</span>
              </div>
              <p className="handling-row__help">
                旋转或新方块出现后，暂停已经蓄好的自动横移。
              </p>
            </div>
            <HandlingRange
              ariaLabel="DCD 截断延迟"
              leftLabel="0F · 关闭"
              max={200}
              min={0}
              onChange={(value) => set("dcdFrameTenths", value)}
              primary={frameLabel(handling.dcdFrameTenths)}
              secondary={
                handling.dcdFrameTenths === 0
                  ? "关闭"
                  : msLabel(handling.dcdFrameTenths)
              }
              rightLabel="20F · 延迟"
              value={handling.dcdFrameTenths}
            />
          </div>
          <div className="handling-row">
            <div className="handling-row__symbol">SDF</div>
            <div>
              <div className="handling-row__title">
                软降速度
                <span className="handling-row__name">SOFT DROP FACTOR</span>
              </div>
              <p className="handling-row__help">
                独立于自然重力；MAX 会降到底部但不会锁定。
              </p>
            </div>
            <HandlingRange
              ariaLabel="SDF 软降速度"
              leftLabel="5× · 精细"
              max={41}
              min={5}
              onChange={(value) => set("sdf", value === 41 ? "sonic" : value)}
              primary={handling.sdf === "sonic" ? "MAX" : `${handling.sdf}×`}
              secondary={handling.sdf === "sonic" ? "降到底但不锁" : "本地展开"}
              rightLabel="MAX · 音速降"
              value={sdfSlider}
            />
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="panel__header">
          <div>
            <h2 className="panel__title">高级输入</h2>
            <p className="panel__description">
              同样只影响本机输入展开，不会上传配置
            </p>
          </div>
        </div>
        <div className="advanced-list">
          <ToggleRow
            help="左右方向切换时清空已经积累的 DAS 时间"
            onChange={(value) => set("dasCancellation", value)}
            title="换向时取消 DAS"
            value={handling.dasCancellation}
          />
          <ToggleRow
            help="自然锁定与硬降按键撞在一起时，避免误砸下一块"
            onChange={(value) => set("safeLock", value)}
            title="防止意外硬降"
            value={handling.safeLock}
          />
          <ToggleRow
            help="高重力同时输入时，让向下移动优先处理"
            onChange={(value) => set("preferSoftDrop", value)}
            title="软降优先于横移"
            value={handling.preferSoftDrop}
          />
          <BufferModeRow
            help="新方块生成时应用提前输入的旋转"
            onChange={(value: BufferMode) => set("irs", value)}
            title="旋转缓冲（IRS）"
            value={handling.irs}
          />
          <BufferModeRow
            help="新方块生成时应用提前输入的 Hold"
            onChange={(value: BufferMode) => set("ihs", value)}
            title="Hold 缓冲（IHS）"
            value={handling.ihs}
          />
        </div>
      </section>
    </>
  );
}
