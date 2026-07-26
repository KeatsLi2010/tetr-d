import type { DgLabChannel, DgLabConfig, DgLabWaveformId } from "../dglab/index.ts";

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

export function DgLabSettingsPanel({
  config,
  saveState,
  onChange,
  onReset
}: DgLabSettingsPanelProps): React.JSX.Element {
  const set = <Key extends keyof DgLabConfig>(key: Key, value: DgLabConfig[Key]): void => onChange({ ...config, [key]: value });
  const setWeight = (key: keyof DgLabConfig["weights"], value: number): void => onChange({ ...config, weights: { ...config.weights, [key]: value } });
  const range = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.round(value)));
  return <section className="panel dglab-panel" id="dglab">
    <div className="panel__header">
      <div><h2 className="panel__title">DG-LAB / 郊狼反馈</h2><p className="panel__description">仅保存在本地浏览器；对局只上传操作，不上传设备指令。必须扫码配对后手动 Arm。</p></div>
      <div className="dglab-panel__actions"><span className={`config-save-state config-save-state--${saveState}`}>{saveState === "saved" ? "已保存" : saveState === "saving" ? "保存中" : "保存失败"}</span><button className="button" onClick={onReset} type="button">恢复默认</button></div>
    </div>
    <div className="dglab-settings-grid">
      <Field label="启用反馈" help="默认关闭；游戏页仍需单独 Arm 才会输出。"><input checked={config.enabled} onChange={(event) => set("enabled", event.currentTarget.checked)} type="checkbox" /></Field>
      <Field label="WebSocket 中继地址" help="例如 ws://192.168.10.207:9999；扫码由 DG-LAB App 完成。"><input onChange={(event) => set("wsUrl", event.currentTarget.value)} placeholder="ws://服务器:9999" spellCheck={false} type="url" value={config.wsUrl} /></Field>
      <Field label="输出通道" help="A/B 双通道独立显示；当前惩罚输出到选中的通道。"><select onChange={(event) => set("channel", event.currentTarget.value as DgLabChannel)} value={config.channel}><option value="A">A 通道</option><option value="B">B 通道</option></select></Field>
      <Field label="波形预设" help="官方 V3 100ms 分片格式，内置呼吸与潮汐两种低强度预设。"><select onChange={(event) => set("waveform", event.currentTarget.value as DgLabWaveformId)} value={config.waveform}><option value="breath">呼吸 / Breath</option><option value="tide">潮汐 / Tide</option></select></Field>
      <Field label={`应用强度上限 ${config.maxStrength}`} help="应用硬上限 200；仍受设备软上限约束。"><input max={200} min={0} onChange={(event) => set("maxStrength", range(Number(event.currentTarget.value), 0, 200))} type="range" value={config.maxStrength} /></Field>
      <Field label={`基础强度 ${config.baseStrength}`} help="每个事件在此基础上按积分增加。"><input max={40} min={0} onChange={(event) => set("baseStrength", range(Number(event.currentTarget.value), 0, 40))} type="range" value={config.baseStrength} /></Field>
      <Field label={`事件冷却 ${config.cooldownMs}ms`} help="限制连续事件，避免短时间堆积输出。"><input max={5000} min={250} onChange={(event) => set("cooldownMs", range(Number(event.currentTarget.value), 250, 5000))} step={50} type="range" value={config.cooldownMs} /></Field>
      <Field label={`最大排队 ${config.maxQueueSeconds}s`} help="超过上限的新事件会丢弃，停止时清空设备队列。"><input max={30} min={1} onChange={(event) => set("maxQueueSeconds", range(Number(event.currentTarget.value), 1, 30))} type="range" value={config.maxQueueSeconds} /></Field>
    </div>
    <div className="dglab-weight-grid"><strong>事件权重</strong><span>断 B2B</span><input max={20} min={0} onChange={(event) => setWeight("b2bBreak", range(Number(event.currentTarget.value), 0, 20))} type="number" value={config.weights.b2bBreak} /><span>续 B2B</span><input max={20} min={0} onChange={(event) => setWeight("b2bContinue", range(Number(event.currentTarget.value), 0, 20))} type="number" value={config.weights.b2bContinue} /><span>连击</span><input max={20} min={0} onChange={(event) => setWeight("combo", range(Number(event.currentTarget.value), 0, 20))} type="number" value={config.weights.combo} /><span>受到攻击</span><input max={20} min={0} onChange={(event) => setWeight("attackReceived", range(Number(event.currentTarget.value), 0, 20))} type="number" value={config.weights.attackReceived} /><span>抵消攻击</span><input max={20} min={0} onChange={(event) => setWeight("attackCancelled", range(Number(event.currentTarget.value), 0, 20))} type="number" value={config.weights.attackCancelled} /></div>
    <p className="dglab-safety-note">安全提示：这是真实电刺激设备控制。请仅在自愿、清醒、可随时停止的情况下使用；不要用于医疗用途，不要在饮酒、驾驶、洗澡、睡眠或有禁忌症时使用。网页失焦、断线和结束对局都会尝试清空队列并归零。</p>
  </section>;
}
