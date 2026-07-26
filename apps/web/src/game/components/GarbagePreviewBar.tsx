import { useEffect, useMemo, useState } from "react";
import type {
  PendingGarbagePacket
} from "../../../../../packages/protocol/src/matchMessages.ts";

import {
  buildGarbagePreviewModel,
  estimateServerFrame,
  SERVER_FRAME_EXTRAPOLATION_MS,
  type ServerFrameAnchor
} from "../duel/garbagePreviewModel.ts";

export interface GarbagePreviewBarProps {
  readonly packets: readonly PendingGarbagePacket[];
  readonly frameAnchor: ServerFrameAnchor;
  readonly simulationHz: number;
  readonly travelFrames: number;
  readonly playerName: string;
}

export function GarbagePreviewBar({
  packets,
  frameAnchor,
  simulationHz,
  travelFrames,
  playerName
}: GarbagePreviewBarProps): React.JSX.Element {
  const [nowMs, setNowMs] = useState(() => performance.now());

  useEffect(() => {
    if (packets.length === 0) return undefined;
    let animationFrame = 0;
    const update = (timestamp: number) => {
      setNowMs(timestamp);
      if (
        timestamp - frameAnchor.receivedAtMs <
        SERVER_FRAME_EXTRAPOLATION_MS
      ) {
        animationFrame = requestAnimationFrame(update);
      }
    };
    animationFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animationFrame);
  }, [frameAnchor.receivedAtMs, packets.length]);

  const model = useMemo(() => {
    const estimatedFrame = estimateServerFrame(
      frameAnchor,
      nowMs,
      simulationHz
    );
    return buildGarbagePreviewModel(
      packets,
      estimatedFrame,
      travelFrames
    );
  }, [frameAnchor, nowMs, packets, simulationHz, travelFrames]);

  const nearestMs = model.nextRemainingFrames === null
    ? null
    : Math.ceil((model.nextRemainingFrames * 1_000) / simulationHz);
  const readyLabel = model.readyAmount > 0
    ? `，${model.readyAmount} 行已进入生效窗口`
    : nearestMs === null ? "" : `，最近一包约 ${nearestMs} 毫秒生效`;
  const hiddenLabel = model.hiddenAmount > 0
    ? `，另有 ${model.hiddenAmount} 行未显示`
    : "";
  return (
    <div
      className="garbage-preview"
      role="img"
      aria-label={
        `${playerName} 待受击 ${model.totalAmount} 行${readyLabel}${hiddenLabel}`
      }
      data-garbage-total={model.totalAmount}
      data-garbage-ready={model.readyAmount}
    >
      <div className="garbage-preview__track">
        {model.segments.map((segment) => (
          <span
            className={[
              "garbage-preview__segment",
              segment.ready ? "garbage-preview__segment--ready" : ""
            ].filter(Boolean).join(" ")}
            data-packet-id={segment.packetId}
            key={segment.packetId}
            style={{
              bottom: `${segment.bottomPercent}%`,
              height: `${segment.heightPercent}%`,
              color: segment.color,
              backgroundColor: segment.color
            }}
            title={segment.ready
              ? `${segment.amount} 行：READY`
              : `${segment.amount} 行：剩余 ${Math.ceil(
                (segment.remainingFrames * 1_000) / simulationHz
              )}ms`}
          />
        ))}
      </div>
      {model.totalAmount > 0 && (
        <output className="garbage-preview__amount">{model.totalAmount}</output>
      )}
    </div>
  );
}
