import { BOARD_WIDTH, VISIBLE_BOARD_HEIGHT } from "@tetr-d/game-core";

import type {
  BoardRenderModel,
  LockedRenderCell,
  PieceRenderCell,
  ScreenCell
} from "./boardRenderModel";
import {
  boardViewportLayout,
  type BoardViewportLayout
} from "./boardViewport.ts";
import {
  GARBAGE_COLOR,
  LOCKED_COLOR,
  PIECE_COLORS
} from "./piecePalette";

const BOARD_BACKGROUND = "#070a11";
const GRID_COLOR = "rgba(186, 205, 239, 0.075)";
const BORDER_COLOR = "rgba(190, 213, 255, 0.24)";
const BUFFER_COLOR = "rgba(255, 113, 139, 0.035)";
const CEILING_COLOR = "rgba(255, 113, 139, 0.3)";

function cellRect(
  layout: BoardViewportLayout,
  cell: ScreenCell,
  sourceRows: number
) {
  const gap = Math.max(0.65, layout.cell * 0.055);
  const animatedRow = cell.row + layout.visibleRows - sourceRows;
  return {
    x: layout.left + cell.column * layout.cell + gap,
    y: layout.top + animatedRow * layout.cell + gap,
    size: Math.max(0, layout.cell - gap * 2)
  };
}

function drawGrid(
  context: CanvasRenderingContext2D,
  layout: BoardViewportLayout
): void {
  context.save();
  context.strokeStyle = GRID_COLOR;
  context.lineWidth = 1;
  context.beginPath();

  for (let column = 1; column < BOARD_WIDTH; column += 1) {
    const x = layout.left + column * layout.cell;
    context.moveTo(x, layout.top);
    context.lineTo(x, layout.top + layout.height);
  }
  for (let row = 1; row < Math.ceil(layout.visibleRows); row += 1) {
    const y = layout.top + layout.height - row * layout.cell;
    if (y <= layout.top) continue;
    context.moveTo(layout.left, y);
    context.lineTo(layout.left + layout.width, y);
  }

  context.stroke();
  context.restore();
}

function drawLockedCell(
  context: CanvasRenderingContext2D,
  layout: BoardViewportLayout,
  cell: LockedRenderCell,
  sourceRows: number
): void {
  const rect = cellRect(layout, cell, sourceRows);
  const garbage = cell.source === "garbage";
  const color = garbage ? GARBAGE_COLOR : LOCKED_COLOR;

  context.fillStyle = color.fill;
  context.fillRect(rect.x, rect.y, rect.size, rect.size);
  context.strokeStyle = color.edge;
  context.lineWidth = Math.max(0.8, layout.cell * 0.045);
  context.strokeRect(rect.x, rect.y, rect.size, rect.size);

  if (garbage) {
    context.save();
    context.beginPath();
    context.rect(rect.x, rect.y, rect.size, rect.size);
    context.clip();
    context.strokeStyle = GARBAGE_COLOR.stripe;
    context.lineWidth = Math.max(1, layout.cell * 0.07);
    const spacing = Math.max(4, layout.cell * 0.34);
    for (let offset = -rect.size; offset < rect.size * 2; offset += spacing) {
      context.beginPath();
      context.moveTo(rect.x + offset, rect.y + rect.size);
      context.lineTo(rect.x + offset + rect.size, rect.y);
      context.stroke();
    }
    context.restore();
  } else {
    const shineHeight = Math.max(1, rect.size * 0.12);
    context.fillStyle = LOCKED_COLOR.shine;
    context.globalAlpha = 0.32;
    context.fillRect(rect.x + 1, rect.y + 1, rect.size - 2, shineHeight);
    context.globalAlpha = 1;
  }
}

function drawGhostCell(
  context: CanvasRenderingContext2D,
  layout: BoardViewportLayout,
  cell: PieceRenderCell,
  sourceRows: number
): void {
  const rect = cellRect(layout, cell, sourceRows);
  const colors = PIECE_COLORS[cell.piece];
  const inset = Math.max(1.2, layout.cell * 0.12);
  context.strokeStyle = colors.edge;
  context.globalAlpha = 0.48;
  context.lineWidth = Math.max(1.2, layout.cell * 0.075);
  context.strokeRect(
    rect.x + inset,
    rect.y + inset,
    Math.max(0, rect.size - inset * 2),
    Math.max(0, rect.size - inset * 2)
  );
  context.globalAlpha = 1;
}

function drawActiveCell(
  context: CanvasRenderingContext2D,
  layout: BoardViewportLayout,
  cell: PieceRenderCell,
  sourceRows: number
): void {
  const rect = cellRect(layout, cell, sourceRows);
  const colors = PIECE_COLORS[cell.piece];
  const gradient = context.createLinearGradient(
    rect.x,
    rect.y,
    rect.x,
    rect.y + rect.size
  );
  gradient.addColorStop(0, colors.edge);
  gradient.addColorStop(0.24, colors.fill);
  gradient.addColorStop(1, colors.fill);

  context.save();
  context.shadowColor = colors.glow;
  context.shadowBlur = Math.max(3, layout.cell * 0.28);
  context.fillStyle = gradient;
  context.fillRect(rect.x, rect.y, rect.size, rect.size);
  context.restore();

  context.strokeStyle = colors.edge;
  context.lineWidth = Math.max(0.8, layout.cell * 0.045);
  context.strokeRect(rect.x, rect.y, rect.size, rect.size);
  context.fillStyle = colors.shine;
  context.globalAlpha = 0.48;
  context.fillRect(
    rect.x + 1,
    rect.y + 1,
    Math.max(0, rect.size - 2),
    Math.max(1, rect.size * 0.1)
  );
  context.globalAlpha = 1;
}

export function renderBoardCanvas(
  context: CanvasRenderingContext2D,
  model: BoardRenderModel,
  width: number,
  height: number,
  displayRows = model.visibleRows
): void {
  context.clearRect(0, 0, width, height);
  if (width <= 0 || height <= 0) return;

  const layout = boardViewportLayout(width, height, displayRows);
  context.fillStyle = BOARD_BACKGROUND;
  context.fillRect(layout.left, layout.top, layout.width, layout.height);

  context.save();
  context.beginPath();
  context.rect(layout.left, layout.top, layout.width, layout.height);
  context.clip();
  if (displayRows > VISIBLE_BOARD_HEIGHT) {
    const ceilingY = (
      layout.top +
      layout.height -
      VISIBLE_BOARD_HEIGHT * layout.cell
    );
    context.fillStyle = BUFFER_COLOR;
    context.fillRect(
      layout.left,
      layout.top,
      layout.width,
      Math.max(0, ceilingY - layout.top)
    );
    context.strokeStyle = CEILING_COLOR;
    context.lineWidth = Math.max(1, layout.cell * 0.055);
    context.beginPath();
    context.moveTo(layout.left, ceilingY);
    context.lineTo(layout.left + layout.width, ceilingY);
    context.stroke();
  }
  drawGrid(context, layout);

  for (const cell of model.locked) {
    drawLockedCell(context, layout, cell, model.visibleRows);
  }
  for (const cell of model.ghost) {
    drawGhostCell(context, layout, cell, model.visibleRows);
  }
  for (const cell of model.active) {
    drawActiveCell(context, layout, cell, model.visibleRows);
  }
  context.restore();

  context.strokeStyle = BORDER_COLOR;
  context.lineWidth = Math.max(1, layout.cell * 0.065);
  context.strokeRect(
    layout.left,
    layout.top,
    layout.width,
    layout.height
  );
}
