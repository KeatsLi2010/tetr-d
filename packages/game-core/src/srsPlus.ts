import type {
  Cell,
  PieceKind,
  RotationDirection,
  RotationState
} from "./types.ts";

type TransitionKey = `${RotationState}>${RotationState}`;
type KickTable = Readonly<Partial<Record<TransitionKey, readonly Cell[]>>>;

function freezeCells(cells: readonly Cell[]): readonly Cell[] {
  for (const cell of cells) {
    Object.freeze(cell);
  }
  return Object.freeze(cells);
}

function freezeKickTable(
  table: Partial<Record<TransitionKey, readonly Cell[]>>
): KickTable {
  for (const tests of Object.values(table)) {
    if (tests !== undefined) {
      freezeCells(tests);
    }
  }
  return Object.freeze(table);
}

const ZERO_KICK = freezeCells([{ x: 0, y: 0 }]);

/**
 * Guideline SRS 90° kicks for J/L/S/T/Z.
 * Test order is behavior: never sort or deduplicate these arrays.
 */
export const JLSTZ_90_KICKS: KickTable = freezeKickTable({
  "0>1": [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: -1, y: 1 },
    { x: 0, y: -2 },
    { x: -1, y: -2 }
  ],
  "1>0": [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: -1 },
    { x: 0, y: 2 },
    { x: 1, y: 2 }
  ],
  "1>2": [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: -1 },
    { x: 0, y: 2 },
    { x: 1, y: 2 }
  ],
  "2>1": [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: -1, y: 1 },
    { x: 0, y: -2 },
    { x: -1, y: -2 }
  ],
  "2>3": [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: -2 },
    { x: 1, y: -2 }
  ],
  "3>2": [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: -1, y: -1 },
    { x: 0, y: 2 },
    { x: -1, y: 2 }
  ],
  "3>0": [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: -1, y: -1 },
    { x: 0, y: 2 },
    { x: -1, y: 2 }
  ],
  "0>3": [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: -2 },
    { x: 1, y: -2 }
  ]
});

/**
 * TETR.IO-style SRS+ 90° kicks for I.
 *
 * These use the same candidate offsets as SRS but reorder them so mirrored
 * rotations have mirrored test order. This is the material SRS+ difference.
 */
export const I_90_KICKS: KickTable = freezeKickTable({
  "0>1": [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: -2, y: 0 },
    { x: -2, y: -1 },
    { x: 1, y: 2 }
  ],
  "1>0": [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: 2, y: 0 },
    { x: -1, y: -2 },
    { x: 2, y: 1 }
  ],
  "1>2": [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: 2, y: 0 },
    { x: -1, y: 2 },
    { x: 2, y: -1 }
  ],
  "2>1": [
    { x: 0, y: 0 },
    { x: -2, y: 0 },
    { x: 1, y: 0 },
    { x: -2, y: 1 },
    { x: 1, y: -2 }
  ],
  "2>3": [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: -1, y: 0 },
    { x: 2, y: 1 },
    { x: -1, y: -2 }
  ],
  "3>2": [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: -2, y: 0 },
    { x: 1, y: 2 },
    { x: -2, y: -1 }
  ],
  "3>0": [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: -2, y: 0 },
    { x: 1, y: -2 },
    { x: -2, y: 1 }
  ],
  "0>3": [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: -1 },
    { x: -1, y: 2 }
  ]
});

/**
 * TETR.IO-style restrained 180° kicks for J/L/S/T/Z.
 * Historically separate from SRS+, bundled by this project profile.
 */
export const JLSTZ_180_KICKS: KickTable = freezeKickTable({
  "0>2": [
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
    { x: 1, y: 0 },
    { x: -1, y: 0 }
  ],
  "1>3": [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 2 },
    { x: 1, y: 1 },
    { x: 0, y: 2 },
    { x: 0, y: 1 }
  ],
  "2>0": [
    { x: 0, y: 0 },
    { x: 0, y: -1 },
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 }
  ],
  "3>1": [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: -1, y: 2 },
    { x: -1, y: 1 },
    { x: 0, y: 2 },
    { x: 0, y: 1 }
  ]
});

/**
 * The I piece uses only its basic 180° position plus one restrained kick.
 * Historically separate from SRS+, bundled by this project profile.
 */
export const I_180_KICKS: KickTable = freezeKickTable({
  "0>2": [
    { x: 0, y: 0 },
    { x: 0, y: 1 }
  ],
  "1>3": [
    { x: 0, y: 0 },
    { x: 1, y: 0 }
  ],
  "2>0": [
    { x: 0, y: 0 },
    { x: 0, y: -1 }
  ],
  "3>1": [
    { x: 0, y: 0 },
    { x: -1, y: 0 }
  ]
});

function transitionKey(
  from: RotationState,
  to: RotationState
): TransitionKey {
  return `${from}>${to}`;
}

export function targetRotation(
  from: RotationState,
  direction: RotationDirection
): RotationState {
  const delta = direction === "cw" ? 1 : direction === "ccw" ? 3 : 2;
  return ((from + delta) % 4) as RotationState;
}

export function getKickTests(
  kind: PieceKind,
  from: RotationState,
  direction: RotationDirection
): readonly Cell[] {
  if (kind === "O") {
    return ZERO_KICK;
  }

  const to = targetRotation(from, direction);
  const key = transitionKey(from, to);
  const table =
    direction === "180"
      ? kind === "I"
        ? I_180_KICKS
        : JLSTZ_180_KICKS
      : kind === "I"
        ? I_90_KICKS
        : JLSTZ_90_KICKS;
  const tests = table[key];

  if (tests === undefined) {
    throw new Error(`Missing rotation kick table for ${kind} ${key}`);
  }

  return tests;
}
