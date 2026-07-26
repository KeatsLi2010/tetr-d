import type { CSSProperties } from "react";
import type { PieceKind } from "@tetr-d/game-core";

import "../../styles/arena-board.css";
import { PIECE_COLORS } from "../render/piecePalette";
import { previewCellsFor } from "../render/piecePreviewModel";

export interface PiecePreviewProps {
  readonly kind: PieceKind | null;
  readonly muted?: boolean;
  readonly className?: string;
  readonly label?: string;
}

export function PiecePreview({
  kind,
  muted = false,
  className = "",
  label
}: PiecePreviewProps): React.JSX.Element {
  const classes = [
    "piece-preview",
    muted ? "piece-preview--muted" : "",
    className
  ].filter(Boolean).join(" ");
  const colors = kind === null ? null : PIECE_COLORS[kind];
  const cellStyle: CSSProperties | undefined = colors === null
    ? undefined
    : {
        background: colors.fill,
        borderColor: colors.edge,
        boxShadow: `0 0 12px ${colors.glow}`
      };

  return (
    <div
      className={classes}
      role="img"
      aria-label={label ?? (kind === null ? "空方块预览" : `${kind} 方块`)}
    >
      {kind !== null && previewCellsFor(kind).map((cell, index) => (
        <span
          className="piece-preview__cell"
          key={`${kind}-${index}`}
          style={{
            ...cellStyle,
            gridColumnStart: cell.column,
            gridRowStart: cell.row
          }}
        />
      ))}
    </div>
  );
}
