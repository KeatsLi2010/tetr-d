import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type {
  ActivePiece,
  Board
} from "@tetr-d/game-core";

import "../../styles/arena-board.css";
import { buildBoardRenderModel } from "../render/boardRenderModel";
import { renderBoardCanvas } from "../render/boardCanvasRenderer";
import {
  boardViewportDuration,
  interpolateBoardVisibleRows
} from "../render/boardViewport.ts";

export interface BoardCanvasProps {
  readonly view: {
    readonly board: Board;
    readonly active: ActivePiece | null;
    readonly toppedOut: boolean;
  };
  readonly className?: string;
  readonly label?: string;
}

const MAX_DEVICE_PIXEL_RATIO = 2;

function drawCanvas(
  canvas: HTMLCanvasElement,
  model: ReturnType<typeof buildBoardRenderModel>,
  displayRows: number
): void {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return;

  const ratio = Math.min(
    MAX_DEVICE_PIXEL_RATIO,
    Math.max(1, window.devicePixelRatio || 1)
  );
  const pixelWidth = Math.max(1, Math.round(bounds.width * ratio));
  const pixelHeight = Math.max(1, Math.round(bounds.height * ratio));

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext("2d");
  if (context === null) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  renderBoardCanvas(
    context,
    model,
    bounds.width,
    bounds.height,
    displayRows
  );
}

export function BoardCanvas({
  view,
  className = "",
  label = "俄罗斯方块棋盘"
}: BoardCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const model = useMemo(
    () => buildBoardRenderModel(view),
    [view.board, view.active]
  );
  const modelRef = useRef(model);
  const displayRowsRef = useRef(model.visibleRows);
  const targetRowsRef = useRef(model.visibleRows);
  const animationFrameRef = useRef<number | null>(null);
  const redrawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const draw = () => drawCanvas(
      canvas,
      modelRef.current,
      displayRowsRef.current
    );
    redrawRef.current = draw;

    draw();
    const stopAnimation = () => {
      if (animationFrameRef.current === null) return;
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    };
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", draw);
      return () => {
        stopAnimation();
        window.removeEventListener("resize", draw);
        if (redrawRef.current === draw) redrawRef.current = null;
      };
    }

    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => {
      stopAnimation();
      observer.disconnect();
      if (redrawRef.current === draw) redrawRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    modelRef.current = model;
    if (targetRowsRef.current === model.visibleRows) {
      redrawRef.current?.();
      return;
    }

    targetRowsRef.current = model.visibleRows;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    const fromRows = displayRowsRef.current;
    const toRows = model.visibleRows;
    const reducedMotion = (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
    if (reducedMotion) {
      displayRowsRef.current = toRows;
      redrawRef.current?.();
      return;
    }

    const duration = boardViewportDuration(fromRows, toRows);
    let startedAt: number | null = null;
    const animate = (timestamp: number) => {
      startedAt ??= timestamp;
      const progress = Math.min(1, (timestamp - startedAt) / duration);
      displayRowsRef.current = interpolateBoardVisibleRows(
        fromRows,
        toRows,
        progress
      );
      redrawRef.current?.();
      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        animationFrameRef.current = null;
      }
    };
    animationFrameRef.current = requestAnimationFrame(animate);
  }, [model]);

  const classes = ["arena-board", className].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <canvas
        ref={canvasRef}
        className="arena-board__canvas"
        role="img"
        aria-label={label}
        data-visible-rows={model.visibleRows}
        data-active-kind={view.active?.kind ?? ""}
        data-active-x={view.active?.x ?? ""}
        data-active-y={view.active?.y ?? ""}
      >
        {label}
      </canvas>
      {view.toppedOut && (
        <div className="arena-board__overlay" role="status">
          <strong>TOP OUT</strong>
          <span>本局已结束</span>
        </div>
      )}
    </div>
  );
}
