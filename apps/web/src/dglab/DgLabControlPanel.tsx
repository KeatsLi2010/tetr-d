import { isWebBluetoothSupported } from "./dglabBluetooth.ts";
import type { DgLabPenaltyState } from "./useDgLabPenalty.ts";

function channelClass(strength: number, limit: number): string {
  if (limit <= 0) return "dglab-channel__fill dglab-channel__fill--offline";
  const ratio = Math.min(1, strength / limit);
  return `dglab-channel__fill ${ratio > .75 ? "dglab-channel__fill--hot" : ratio > .45 ? "dglab-channel__fill--warm" : ""}`;
}

export function DgLabControlPanel({
  penalty
}: {
  readonly penalty: DgLabPenaltyState;
}): React.JSX.Element {
  const status = penalty.status;
  const armDisabled = status.connection !== "paired" || !penalty.enabled;
  const connectionLabel = status.connection === "paired" ? "已连接" : status.connection === "connecting" ? "正在选择设备" : status.connection === "error" ? "连接错误" : "未连接";
  return <section className="dglab-control" aria-label="DG-LAB 控制">
    <header className="dglab-control__header"><div><span className="dglab-control__eyebrow">LOCAL DEVICE / DG-LAB</span><strong>{connectionLabel}</strong></div><span className={`dglab-control__armed ${status.armed ? "dglab-control__armed--on" : ""}`}>{status.armed ? "ARMED" : "SAFE"}</span></header>
    <div className="dglab-channels">
      {(["A", "B"] as const).map((channel) => {
        const state = status.channels[channel];
        const ratio = state.limit > 0 ? Math.min(100, state.strength / state.limit * 100) : 0;
        return <div className="dglab-channel" key={channel}><div className="dglab-channel__label"><span>{channel} 通道</span><strong>{state.strength}<small> / {state.limit || "—"}</small></strong></div><div className="dglab-channel__track"><span className={channelClass(state.strength, state.limit)} style={{ width: `${ratio}%` }} /></div></div>;
      })}
    </div>
    <div className="dglab-bluetooth-note"><span className="dglab-bluetooth-note__badge">BLUETOOTH DIRECT</span><p>{isWebBluetoothSupported() ? "浏览器支持直连，点击下方选择郊狼 3.0。" : "需要 HTTPS 或 localhost，并使用支持 Web Bluetooth 的 Chrome / Edge。"}</p></div>
    <div className="dglab-control__actions"><button className="button" onClick={penalty.connect} type="button">选择蓝牙设备</button><button className="button" disabled={armDisabled} onClick={() => penalty.arm()} title={!penalty.enabled ? "请先在 DG-LAB 设置中启用反馈" : undefined} type="button">Arm</button><button className="button" disabled={!status.armed} onClick={penalty.test} type="button">测试</button><button className="button button--danger" onClick={penalty.disarm} type="button">急停</button></div>
    {!penalty.enabled && <p className="dglab-control__hint">请先在上方 DG-LAB 设置勾选“启用反馈”，然后再 Arm。</p>}
    {status.lastError !== null && <p className="dglab-control__error" role="alert">{status.lastError}</p>}
    <p className="dglab-control__hint">排队 {status.queuedSeconds.toFixed(1)}s · 失焦、断线、离开对局会自动解除 Arm 并清空队列。</p>
  </section>;
}
