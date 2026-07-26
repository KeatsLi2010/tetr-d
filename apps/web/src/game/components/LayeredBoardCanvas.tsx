import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef
} from "react";
import type { ActivePiece, Board } from "@tetr-d/game-core";

import "../../styles/arena-board.css";
import {
  findGhostPiece,
  lockedCellsForBoard,
  visibleCellsForPiece,
  type BoardRenderModel
} from "../render/boardRenderModel.ts";
import {
  renderBoardDynamicLayer,
  renderBoardStaticLayer
} from "../render/boardCanvasRenderer.ts";
import {
  activePiecesEqual,
  boardCellsEqual,
  planBoardLayerDraw,
  type BoardVisualState
} from "../render/boardRenderInvalidation.ts";
import {
  boardViewportDuration,
  interpolateBoardVisibleRows,
  targetBoardVisibleRows
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

export interface BoardCanvasMetrics {
  readonly width: number;
  readonly height: number;
  readonly ratio: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

const MAX_DEVICE_PIXEL_RATIO = 2;

export function createBoardCanvasMetrics(
  width: number,
  height: number,
  devicePixelRatio: number
): BoardCanvasMetrics {
  const ratio = Math.min(
    MAX_DEVICE_PIXEL_RATIO,
    Math.max(1, devicePixelRatio || 1)
  );
  return {
    width,
    height,
    ratio,
    pixelWidth: Math.max(1, Math.round(width * ratio)),
    pixelHeight: Math.max(1, Math.round(height * ratio))
  };
}

export function boardCanvasMetricsEqual(
  left: BoardCanvasMetrics | null,
  right: BoardCanvasMetrics
): boolean {
  return (
    left !== null &&
    left.width === right.width &&
    left.height === right.height &&
    left.ratio === right.ratio &&
    left.pixelWidth === right.pixelWidth &&
    left.pixelHeight === right.pixelHeight
  );
}

function syncCanvasSize(
  canvas: HTMLCanvasElement,
  metrics: BoardCanvasMetrics
): void {
  if (canvas.width !== metrics.pixelWidth) {
    canvas.width = metrics.pixelWidth;
  }
  if (canvas.height !== metrics.pixelHeight) {
    canvas.height = metrics.pixelHeight;
  }
}

function drawLayer(
  canvas: HTMLCanvasElement,
  metrics: BoardCanvasMetrics,
  model: BoardRenderModel,
  displayRows: number,
  render: typeof renderBoardStaticLayer
): void {
  if (metrics.width <= 0 || metrics.height <= 0) return;
  const context = canvas.getContext("2d");
  if (context === null) return;
  context.setTransform(metrics.ratio, 0, 0, metrics.ratio, 0, 0);
  render(
    context,
    model,
    metrics.width,
    metrics.height,
    displayRows
  );
}

function useStableBoard(board: Board): Board {
  const stable = useRef(board);
  if (!boardCellsEqual(stable.current, board)) stable.current = board;
  return stable.current;
}

function useStableActive(active: ActivePiece | null): ActivePiece | null {
  const stable = useRef(active);
  if (!activePiecesEqual(stable.current, active)) stable.current = active;
  return stable.current;
}

function staticModelFor(
  board: Board,
  visibleRows: number
): BoardRenderModel {
  return {
    visibleRows,
    locked: lockedCellsForBoard(board, visibleRows),
    ghost: [],
    active: []
  };
}

function dynamicModelFor(
  board: Board,
  active: ActivePiece | null,
  visibleRows: number
): BoardRenderModel {
  if (active === null) {
    return { visibleRows, locked: [], ghost: [], active: [] };
  }
  return {
    visibleRows,
    locked: [],
    ghost: visibleCellsForPiece(
      findGhostPiece(board, active),
      "ghost",
      visibleRows
    ),
    active: visibleCellsForPiece(active, "active", visibleRows)
  };
}

function BoardCanvasComponent({
  view,
  className = "",
  label = "俄罗斯方块棋盘"
}: BoardCanvasProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const staticCanvasRef = useRef<HTMLCanvasElement>(null);
  const dynamicCanvasRef = useRef<HTMLCanvasElement>(null);
  const board = useStableBoard(view.board);
  const active = useStableActive(view.active);
  const visibleRows = targetBoardVisibleRows({ board, active });
  const staticModel = useMemo(
    () => staticModelFor(board, visibleRows),
    [board, visibleRows]
  );
  const dynamicModel = useMemo(
    () => dynamicModelFor(board, active, visibleRows),
    [active, board, visibleRows]
  );
  const staticModelRef = useRef(staticModel);
  const dynamicModelRef = useRef(dynamicModel);
  const visualRef = useRef<BoardVisualState | null>(null);
  const metricsRef = useRef<BoardCanvasMetrics | null>(null);
  const displayRowsRef = useRef(visibleRows);
  const targetRowsRef = useRef(visibleRows);
  const animationFrameRef = useRef<number | null>(null);
  const drawStaticRef = useRef<(() => void) | null>(null);
  const drawDynamicRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const staticCanvas = staticCanvasRef.current;
    const dynamicCanvas = dynamicCanvasRef.current;
    if (
      host === null ||
      staticCanvas === null ||
      dynamicCanvas === null
    ) return;

    const drawStatic = () => {
      const metrics = metricsRef.current;
      if (metrics === null) return;
      drawLayer(
        staticCanvas,
        metrics,
        staticModelRef.current,
        displayRowsRef.current,
        renderBoardStaticLayer
      );
    };
    const drawDynamic = () => {
      const metrics = metricsRef.current;
      if (metrics === null) return;
      drawLayer(
        dynamicCanvas,
        metrics,
        dynamicModelRef.current,
        displayRowsRef.current,
        renderBoardDynamicLayer
      );
    };
    drawStaticRef.current = drawStatic;
    drawDynamicRef.current = drawDynamic;

    const resize = (width: number, height: number) => {
      const next = createBoardCanvasMetrics(
        width,
        height,
        window.devicePixelRatio
      );
      if (boardCanvasMetricsEqual(metricsRef.current, next)) return;
      metricsRef.current = next;
      syncCanvasSize(staticCanvas, next);
      syncCanvasSize(dynamicCanvas, next);
      drawStatic();
      drawDynamic();
    };
    const measure = () => {
      const bounds = host.getBoundingClientRect();
      resize(bounds.width, bounds.height);
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(([entry]) => {
        if (entry !== undefined) {
          resize(entry.contentRect.width, entry.contentRect.height);
        }
      });
    observer?.observe(host);
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      drawStaticRef.current = null;
      drawDynamicRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    staticModelRef.current = staticModel;
    dynamicModelRef.current = dynamicModel;
    const visual = { board, active, visibleRows };
    const drawPlan = planBoardLayerDraw(visualRef.current, visual);
    visualRef.current = visual;
    if (targetRowsRef.current === visibleRows) {
      if (drawPlan.staticLayer) drawStaticRef.current?.();
      if (drawPlan.dynamicLayer) drawDynamicRef.current?.();
      return;
    }

    targetRowsRef.current = visibleRows;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    const fromRows = displayRowsRef.current;
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      displayRowsRef.current = visibleRows;
      drawStaticRef.current?.();
      drawDynamicRef.current?.();
      return;
    }

    const duration = boardViewportDuration(fromRows, visibleRows);
    let startedAt: number | null = null;
    const animate = (timestamp: number) => {
      startedAt ??= timestamp;
      const progress = Math.min(1, (timestamp - startedAt) / duration);
      displayRowsRef.current = interpolateBoardVisibleRows(
        fromRows,
        visibleRows,
        progress
      );
      drawStaticRef.current?.();
      drawDynamicRef.current?.();
      animationFrameRef.current = progress < 1
        ? requestAnimationFrame(animate)
        : null;
    };
    animationFrameRef.current = requestAnimationFrame(animate);
  }, [active, board, dynamicModel, staticModel, visibleRows]);

  const classes = ["arena-board", className].filter(Boolean).join(" ");
  return (
    <div className={classes} ref={hostRef}>
      <canvas
        aria-hidden="true"
        className="arena-board__canvas arena-board__canvas--static"
        ref={staticCanvasRef}
      />
      <canvas
        aria-label={label}
        className="arena-board__canvas arena-board__canvas--dynamic"
        data-active-kind={active?.kind ?? ""}
        data-active-x={active?.x ?? ""}
        data-active-y={active?.y ?? ""}
        data-visible-rows={visibleRows}
        ref={dynamicCanvasRef}
        role="img"
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

export function boardCanvasPropsEqual(
  previous: BoardCanvasProps,
  next: BoardCanvasProps
): boolean {
  return (
    (previous.className ?? "") === (next.className ?? "") &&
    (previous.label ?? "") === (next.label ?? "") &&
    previous.view.toppedOut === next.view.toppedOut &&
    boardCellsEqual(previous.view.board, next.view.board) &&
    activePiecesEqual(previous.view.active, next.view.active)
  );
}

export const BoardCanvas = memo(
  BoardCanvasComponent,
  boardCanvasPropsEqual
);
