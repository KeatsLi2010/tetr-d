import { useEffect, useMemo, useRef, useState } from "react";

import type { PlayerConfig } from "../config/v3/index.ts";
import {
  HandlingEngine,
  type ExpandedPlayerAction
} from "../input/public.ts";
import { Icon } from "../ui/Icon";

interface HandlingTesterProps {
  readonly config: PlayerConfig;
}

interface PieceState {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly generation: number;
}

const INITIAL_PIECE: PieceState = {
  x: 3,
  y: 1,
  rotation: 0,
  generation: 1
};

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT");
}

function applyAction(
  piece: PieceState,
  action: ExpandedPlayerAction
): PieceState {
  if (action.kind === "shift") {
    const x = action.mode === "wall"
      ? action.direction === "left" ? 0 : 7
      : Math.max(0, Math.min(7, piece.x + (
          action.direction === "left" ? -1 : 1
        )));
    return { ...piece, x };
  }
  if (action.kind === "softDrop") {
    const cells = action.mode === "floor" ? 14 : action.cells;
    return { ...piece, y: Math.min(12, piece.y + cells) };
  }
  if (action.kind === "rotate") {
    const delta = action.direction === "cw"
      ? 1
      : action.direction === "ccw" ? -1 : 2;
    return { ...piece, rotation: (piece.rotation + delta + 4) % 4 };
  }
  if (action.kind === "hardDrop") {
    return {
      ...INITIAL_PIECE,
      generation: piece.generation + 1
    };
  }
  if (action.kind === "hold") {
    return {
      ...INITIAL_PIECE,
      generation: piece.generation + 1
    };
  }
  return piece;
}

export function HandlingTester({
  config
}: HandlingTesterProps): React.JSX.Element {
  const [active, setActive] = useState(false);
  const [piece, setPiece] = useState(INITIAL_PIECE);
  const [actionCount, setActionCount] = useState(0);
  const [direction, setDirection] = useState<string>("—");
  const engine = useRef<HandlingEngine | null>(null);
  const boundCodes = useMemo(
    () => new Set(Object.values(config.bindings).flat()),
    [config.bindings]
  );

  useEffect(() => {
    if (!active) {
      engine.current = null;
      return;
    }
    engine.current = new HandlingEngine(config, {
      startTimeMs: performance.now(),
      softDropBaseCellsPerSecond: 60
    });
    setPiece(INITIAL_PIECE);
    setActionCount(0);
    setDirection("—");
  }, [active, config]);

  useEffect(() => {
    if (!active) return;
    const dispatch = (
      initial: readonly ExpandedPlayerAction[],
      atMs: number
    ): void => {
      if (initial.length === 0) return;
      const actions: ExpandedPlayerAction[] = [];
      for (const action of initial) {
        actions.push(action);
        if (action.kind === "hardDrop" || action.kind === "hold") {
          actions.push(...(
            engine.current?.notifyPieceSpawned(atMs, action.kind) ?? []
          ));
        }
      }
      setPiece((current) =>
        actions.reduce((next, action) => applyAction(next, action), current)
      );
      setActionCount((count) => count + actions.length);
      setDirection(engine.current?.activeDirection ?? "—");
    };
    const keyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target) || event.isComposing) return;
      if (!boundCodes.has(event.code)) return;
      event.preventDefault();
      const atMs = performance.now();
      dispatch(engine.current?.keyDown({
        code: event.code,
        atMs,
        repeat: event.repeat
      }) ?? [], atMs);
    };
    const keyUp = (event: KeyboardEvent): void => {
      if (!boundCodes.has(event.code)) return;
      event.preventDefault();
      const atMs = performance.now();
      dispatch(engine.current?.keyUp({
        code: event.code,
        atMs
      }) ?? [], atMs);
    };
    const blur = (): void => {
      engine.current?.blur(performance.now());
      setDirection("—");
    };
    let frame = 0;
    const tick = (): void => {
      const atMs = performance.now();
      dispatch(engine.current?.advance(atMs) ?? [], atMs);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("keyup", keyUp, true);
    window.addEventListener("blur", blur);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("keyup", keyUp, true);
      window.removeEventListener("blur", blur);
    };
  }, [active, boundCodes]);

  return (
    <aside className="tester">
      <div className="tester__header">
        <div>
          <div className="tester__eyebrow">HANDLING LAB / LOCAL</div>
          <div className="tester__title">即时手感测试</div>
        </div>
        <span className={`tester__state ${
          active ? "tester__state--active" : ""
        }`}>
          {active ? "CAPTURING" : "IDLE"}
        </span>
      </div>
      <div className="tester__body">
        <div
          aria-label="手感测试棋盘"
          className="mini-stage"
          onClick={() => !active && setActive(true)}
          role="img"
        >
          <div
            className="mini-piece"
            style={{
              "--piece-x": piece.x,
              "--piece-y": piece.y,
              transform: `rotate(${piece.rotation * 90}deg)`
            } as React.CSSProperties}
          >
            <span /><span /><span /><span />
          </div>
        </div>
        <div className="tester__metrics">
          <div className="tester__metric">
            <strong>{actionCount}</strong>
            <span>ACTIONS</span>
          </div>
          <div className="tester__metric">
            <strong>{piece.generation}</strong>
            <span>PIECE</span>
          </div>
          <div className="tester__metric">
            <strong>{direction}</strong>
            <span>DIRECTION</span>
          </div>
        </div>
        <p className="tester__instructions">
          {active
            ? <><strong>正在捕获按键。</strong>试着长按左右、软降或旋转。</>
            : <>点击棋盘或下方按钮，使用当前键位直接测试。</>}
        </p>
      </div>
      <div className="tester__footer">
        <button
          className={`button ${active ? "" : "button--primary"}`}
          onClick={() => setActive((value) => !value)}
          type="button"
        >
          <Icon name="keyboard" />
          {active ? "结束测试" : "开始测试"}
        </button>
        <button
          aria-label="重置测试棋盘"
          className="icon-button"
          onClick={() => {
            setPiece(INITIAL_PIECE);
            setActionCount(0);
          }}
          type="button"
        >
          <Icon name="refresh" />
        </button>
      </div>
      <div className="latency-note">
        <strong>零等待输入：</strong>
        测试与正式对局都会先在本机执行，再异步上传有序操作；
        后续服务器 ACK 不会阻塞下一次按键。
      </div>
    </aside>
  );
}
