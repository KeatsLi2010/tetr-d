import type { DgLabChannel, DgLabConfig, DgLabWaveformId } from "../dglab/index.ts";
import { waveformFrames } from "../dglab/index.ts";
import { DgLabWaveformEditor } from "./DgLabWaveformEditor.tsx";

interface DgLabSettingsPanelProps {
  readonly config: DgLabConfig;
  readonly saveState: "saved" | "saving" | "error";
  readonly onChange: (config: DgLabConfig) => void;
  readonly onReset: () => void;
}

function Field({
  label,
  help,
  children
}: {
  readonly label: string;
  readonly help: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return <label className="dglab-field"><span>{label}</span>{children}<small>{help}</small></label>;
}

function ChoiceGroup<T extends string>({
  value,
  options,
  onChange
}: {
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
}): React.JSX.Element {
  return <div className="dglab-choice" role="radiogroup">
    {options.map((option) => <button aria-checked={value === option.value} className={value === option.value ? "dglab-choice__button dglab-choice__button--active" : "dglab-choice__button"} key={option.value} onClick={() => onChange(option.value)} role="radio" type="button">{option.label}</button>)}
  </div>;
}

export function DgLabSettingsPanel({
  config,
  saveState,
  onChange,
  onReset
}: DgLabSettingsPanelProps): React.JSX.Element {
  const set = <Key extends keyof DgLabConfig>(key: Key, value: DgLabConfig[Key]): void => onChange({ ...config, [key]: value });
  const setWeight = (key: keyof DgLabConfig["weights"], value: number): void => onChange({ ...config, weights: { ...config.weights, [key]: value } });
  const setWaveform = (waveform: DgLabWaveformId): void => onChange({ ...config, waveform, customWaveform: waveform === "custom" && config.customWaveform.length < 4 ? waveformFrames("breath") : config.customWaveform });
  const range = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.round(value)));
  return <section className="panel dglab-panel" id="dglab">
    <div className="panel__header">
      <div><h2 className="panel__title">DG-LAB / 郊狼反馈</h2><p className="panel__description">仅保存在本地浏览器；对局只上传操作，不上传设备指令。蓝牙连接后仍需手动 Arm。</p></div>
      <div className="dglab-panel__actions"><span className={`config-save-state config-save-state--${saveState}`}>{saveState === "saved" ? "已保存" : saveState === "saving" ? "保存中" : "保存失败"}</span><button className="button" onClick={onReset} type="button">恢复默认</button></div>
    </div>
    <div className="dglab-settings-grid">
      <Field label="启用反馈" help="默认关闭；游戏页仍需单独 Arm 才会输出。"><input checked={config.enabled} onChange={(event) => set("enabled", event.currentTarget.checked)} type="checkbox" /></Field>
      <Field label="连接方式" help="浏览器直接连接郊狼 3.0，不经过 WebSocket 中继；配置和最近设备提示保存在当前 Origin，本地刷新后可手动恢复。"><div className="dglab-device-mode"><span>Web Bluetooth</span><strong>本地直连</strong></div></Field>
      <Field label="输出通道" help="A/B 双通道独立显示；当前惩罚输出到选中的通道。"><ChoiceGroup options={[{ value: "A" as const, label: "A 通道" }, { value: "B" as const, label: "B 通道" }]} value={config.channel} onChange={(value: DgLabChannel) => set("channel", value)} /></Field>
      <Field label="波形预设" help="官方 V3 每 100ms 写入四个 25ms 单元；自定义支持编辑或导入。"><ChoiceGroup options={[{ value: "breath" as const, label: "呼吸 / Breath" }, { value: "tide" as const, label: "潮汐 / Tide" }, { value: "custom" as const, label: "自定义 / Custom" }]} value={config.waveform} onChange={setWaveform} /></Field>
      <Field label={`应用强度上限 ${config.maxStrength}`} help="应用硬上限 200；仍受设备软上限约束。"><input max={200} min={0} onChange={(event) => set("maxStrength", range(Number(event.currentTarget.value), 0, 200))} type="range" value={config.maxStrength} /></Field>
      <Field label={`基础强度 ${config.baseStrength}`} help="每个事件在此基础上按积分增加。"><input max={40} min={0} onChange={(event) => set("baseStrength", range(Number(event.currentTarget.value), 0, 40))} type="range" value={config.baseStrength} /></Field>
      <Field label={`事件冷却 ${config.cooldownMs}ms`} help="限制连续事件，避免短时间堆积输出。"><input max={5000} min={250} onChange={(event) => set("cooldownMs", range(Number(event.currentTarget.value), 250, 5000))} step={50} type="range" value={config.cooldownMs} /></Field>
      <Field label={`最大排队 ${config.maxQueueSeconds}s`} help="超过上限的新事件会丢弃，停止时清空设备队列。"><input max={30} min={1} onChange={(event) => set("maxQueueSeconds", range(Number(event.currentTarget.value), 1, 30))} type="range" value={config.maxQueueSeconds} /></Field>
    </div>
    {config.waveform === "custom" && <DgLabWaveformEditor config={config} onChange={onChange} />}
    <div className="dglab-weight-grid"><strong>事件权重</strong><div className="dglab-weight-row"><span>断 B2B（按连数）</span><input max={20} min={0} onChange={(event) => setWeight("b2bBreak", range(Number(event.currentTarget.value), 0, 20))} type="number" value={config.weights.b2bBreak} /></div><div className="dglab-weight-row"><span>续 B2B（固定）</span><input max={20} min={0} onChange={(event) => setWeight("b2bContinue", range(Number(event.currentTarget.value), 0, 20))} type="number" value={config.weights.b2bContinue} /></div><div className="dglab-weight-row"><span>连击（按连数）</span><input max={20} min={0} onChange={(event) => setWeight("combo", range(Number(event.currentTarget.value), 0, 20))} type="number" value={config.weights.combo} /></div><div className="dglab-weight-row"><span>受到攻击</span><input max={20} min={0} onChange={(event) => setWeight("attackReceived", range(Number(event.currentTarget.value), 0, 20))} type="number" value={config.weights.attackReceived} /></div><div className="dglab-weight-row"><span>抵消攻击</span><input max={20} min={0} onChange={(event) => setWeight("attackCancelled", range(Number(event.currentTarget.value), 0, 20))} type="number" value={config.weights.attackCancelled} /></div></div>
    <p className="dglab-safety-note">安全提示：这是真实电刺激设备控制。请仅在自愿、清醒、可随时停止的情况下使用；不要用于医疗用途，不要在饮酒、驾驶、洗澡、睡眠或有禁忌症时使用。网页失焦、断线和结束对局都会尝试清空队列并归零。</p>
  </section>;
}
