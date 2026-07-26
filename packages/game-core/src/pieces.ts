import type { Cell, PieceKind, RotationState } from "./types.ts";

interface Pivot {
  readonly x: number;
  readonly y: number;
}

const SPAWN_CELLS: Readonly<Record<PieceKind, readonly Cell[]>> = {
  I: [
    { x: 0, y: 2 },
    { x: 1, y: 2 },
    { x: 2, y: 2 },
    { x: 3, y: 2 }
  ],
  J: [
    { x: 0, y: 2 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1 }
  ],
  L: [
    { x: 2, y: 2 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1 }
  ],
  O: [
    { x: 1, y: 2 },
    { x: 2, y: 2 },
    { x: 1, y: 1 },
    { x: 2, y: 1 }
  ],
  S: [
    { x: 1, y: 2 },
    { x: 2, y: 2 },
    { x: 0, y: 1 },
    { x: 1, y: 1 }
  ],
  T: [
    { x: 1, y: 2 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1 }
  ],
  Z: [
    { x: 0, y: 2 },
    { x: 1, y: 2 },
    { x: 1, y: 1 },
    { x: 2, y: 1 }
  ]
};

const PIVOTS: Readonly<Record<PieceKind, Pivot>> = {
  I: { x: 1.5, y: 1.5 },
  J: { x: 1, y: 1 },
  L: { x: 1, y: 1 },
  O: { x: 1.5, y: 1.5 },
  S: { x: 1, y: 1 },
  T: { x: 1, y: 1 },
  Z: { x: 1, y: 1 }
};

for (const cells of Object.values(SPAWN_CELLS)) {
  for (const cell of cells) {
    Object.freeze(cell);
  }
  Object.freeze(cells);
}
Object.freeze(SPAWN_CELLS);

for (const pivot of Object.values(PIVOTS)) {
  Object.freeze(pivot);
}
Object.freeze(PIVOTS);

function rotateCellClockwise(cell: Cell, pivot: Pivot): Cell {
  const relativeX = cell.x - pivot.x;
  const relativeY = cell.y - pivot.y;

  return {
    x: Math.round(pivot.x + relativeY),
    y: Math.round(pivot.y - relativeX)
  };
}

export function localCellsFor(
  kind: PieceKind,
  rotation: RotationState
): readonly Cell[] {
  let cells = SPAWN_CELLS[kind];
  const pivot = PIVOTS[kind];

  for (let turn = 0; turn < rotation; turn += 1) {
    cells = cells.map((cell) => rotateCellClockwise(cell, pivot));
  }

  return cells;
}

export function worldCellsFor(
  kind: PieceKind,
  rotation: RotationState,
  originX: number,
  originY: number
): readonly Cell[] {
  return localCellsFor(kind, rotation).map((cell) => ({
    x: originX + cell.x,
    y: originY + cell.y
  }));
}
