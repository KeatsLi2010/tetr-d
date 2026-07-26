import { localCellsFor } from "@tetr-d/game-core";
import type { PieceKind } from "@tetr-d/game-core";

export interface PreviewCell {
  readonly column: number;
  readonly row: number;
}

export function previewCellsFor(kind: PieceKind): readonly PreviewCell[] {
  const cells = localCellsFor(kind, 0);
  const xs = cells.map((cell) => cell.x);
  const ys = cells.map((cell) => cell.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const offsetX = Math.floor((4 - width) / 2);
  const offsetY = Math.floor((4 - height) / 2);

  return cells.map((cell) => ({
    column: offsetX + cell.x - minX + 1,
    row: offsetY + maxY - cell.y + 1
  }));
}
