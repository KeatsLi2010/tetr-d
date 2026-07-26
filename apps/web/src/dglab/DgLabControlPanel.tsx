import { useEffect, useState } from "react";
import QRCode from "qrcode";

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
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (penalty.status.pairingUrl === null) { setQr(null); return () => { alive = false; }; }
    void QRCode.toDataURL(penalty.status.pairingUrl, { width: 180, margin: 1, color: { dark: "#eaf3ff", light: "#101522" } })
      .then((data) => { if (alive) setQr(data); })
      .catch(() => { if (alive) setQr(null); });
    return () => { alive = false; };
  }, [penalty.status.pairingUrl]);

  const status = penalty.status;
  const connectionLabel = status.connection === "paired" ? "已配对" : status.connection === "waiting-bind" ? "等待 App 扫码" : status.connection === "connecting" ? "连接中" : status.connection === "error" ? "连接错误" : "未连接";
  return <section className="dglab-control" aria-label="DG-LAB 控制">
    <header className="dglab-control__header"><div><span className="dglab-control__eyebrow">LOCAL DEVICE / DG-LAB</span><strong>{connectionLabel}</strong></div><span className={`dglab-control__armed ${status.armed ? "dglab-control__armed--on" : ""}`}>{status.armed ? "ARMED" : "SAFE"}</span></header>
    <div className="dglab-channels">
      {(["A", "B"] as const).map((channel) => {
        const state = status.channels[channel];
        const ratio = state.limit > 0 ? Math.min(100, state.strength / state.limit * 100) : 0;
        return <div className="dglab-channel" key={channel}><div className="dglab-channel__label"><span>{channel} 通道</span><strong>{state.strength}<small> / {state.limit || "—"}</small></strong></div><div className="dglab-channel__track"><span className={channelClass(state.strength, state.limit)} style={{ width: `${ratio}%` }} /></div></div>;
      })}
    </div>
    {status.pairingUrl !== null && <div className="dglab-pairing"><div className="dglab-pairing__qr">{qr === null ? <span>二维码生成中</span> : <img alt="DG-LAB App 扫码配对" src={qr} />}</div><div><strong>用 DG-LAB App 扫码</strong><p>打开 App 的 SOCKET 功能，扫描二维码完成配对。设备控制只发生在本地浏览器。</p><code>{status.pairingUrl}</code></div></div>}
    <div className="dglab-control__actions"><button className="button" onClick={penalty.connect} type="button">连接 / 生成二维码</button><button className="button" disabled={status.connection !== "paired"} onClick={() => penalty.arm()} type="button">Arm</button><button className="button" disabled={!status.armed} onClick={penalty.test} type="button">测试</button><button className="button button--danger" onClick={penalty.disarm} type="button">急停</button></div>
    {status.lastError !== null && <p className="dglab-control__error" role="alert">{status.lastError}</p>}
    <p className="dglab-control__hint">排队 {status.queuedSeconds.toFixed(1)}s · 失焦、断线、离开对局会自动解除 Arm 并清空队列。</p>
  </section>;
}

