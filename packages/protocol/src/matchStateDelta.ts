import type {
  PlayerPatch,
  PlayerSnapshot
} from "./matchMessages.ts";

function sameArray<T>(
  left: readonly T[],
  right: readonly T[]
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function patchPlayer(
  before: PlayerSnapshot,
  after: PlayerSnapshot
): PlayerPatch | null {
  if (
    before.playerId !== after.playerId ||
    before.boardRows.length !== after.boardRows.length ||
    before.garbageRows.length !== after.garbageRows.length
  ) return null;
  const changedRows = after.boardRows.flatMap((bits, y) =>
    bits === before.boardRows[y] &&
    after.garbageRows[y] === before.garbageRows[y]
      ? []
      : [{ y, bits, garbage: after.garbageRows[y] ?? false }]
  );
  const patch: PlayerPatch = {
    playerId: after.playerId,
    ...(changedRows.length === 0
      ? {}
      : { changedRows: Object.freeze(changedRows) }),
    ...(sameJson(before.active, after.active)
      ? {}
      : { active: after.active }),
    ...(before.hold === after.hold ? {} : { hold: after.hold }),
    ...(sameArray(before.next, after.next) ? {} : { next: after.next }),
    ...(before.combo === after.combo ? {} : { combo: after.combo }),
    ...(before.backToBack === after.backToBack
      ? {}
      : { backToBack: after.backToBack }),
    ...(before.piecesPlaced === after.piecesPlaced
      ? {}
      : { piecesPlaced: after.piecesPlaced }),
    ...(before.totalAttackSent === after.totalAttackSent
      ? {}
      : { totalAttackSent: after.totalAttackSent }),
    ...(sameJson(before.pendingGarbage, after.pendingGarbage)
      ? {}
      : { pendingGarbage: after.pendingGarbage }),
    ...(before.toppedOut === after.toppedOut
      ? {}
      : { toppedOut: after.toppedOut })
  };
  return Object.keys(patch).length === 1 ? null : Object.freeze(patch);
}

export function createPlayerPatches(
  before: readonly PlayerSnapshot[],
  after: readonly PlayerSnapshot[]
): readonly PlayerPatch[] | null {
  if (
    before.length !== after.length ||
    before.some((player, index) =>
      player.playerId !== after[index]?.playerId
    )
  ) return null;
  return Object.freeze(after.flatMap((player, index) => {
    const patch = patchPlayer(before[index]!, player);
    return patch === null ? [] : [patch];
  }));
}

function has<K extends PropertyKey>(
  value: object,
  key: K
): value is Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function applyPatch(
  before: PlayerSnapshot,
  patch: PlayerPatch
): PlayerSnapshot {
  const changedRows = patch.changedRows ?? [];
  const boardRows = changedRows.length === 0
    ? null : [...before.boardRows];
  const garbageRows = changedRows.length === 0
    ? null : [...before.garbageRows];
  for (const row of changedRows) {
    if (
      !Number.isSafeInteger(row.y) ||
      row.y < 0 ||
      row.y >= before.boardRows.length
    ) throw new RangeError("Invalid match delta row.");
    boardRows![row.y] = row.bits;
    garbageRows![row.y] = row.garbage;
  }
  return Object.freeze({
    playerId: before.playerId,
    boardRows: boardRows === null
      ? before.boardRows : Object.freeze(boardRows),
    garbageRows: garbageRows === null
      ? before.garbageRows : Object.freeze(garbageRows),
    active: has(patch, "active")
      ? patch.active as PlayerSnapshot["active"]
      : before.active,
    hold: has(patch, "hold")
      ? patch.hold as PlayerSnapshot["hold"]
      : before.hold,
    next: has(patch, "next")
      ? Object.freeze([...(patch.next ?? [])])
      : before.next,
    combo: patch.combo ?? before.combo,
    backToBack: patch.backToBack ?? before.backToBack,
    piecesPlaced: patch.piecesPlaced ?? before.piecesPlaced,
    totalAttackSent: patch.totalAttackSent ?? before.totalAttackSent,
    pendingGarbage: has(patch, "pendingGarbage")
      ? Object.freeze([...(patch.pendingGarbage ?? [])])
      : before.pendingGarbage,
    toppedOut: patch.toppedOut ?? before.toppedOut
  });
}

export function applyPlayerPatches(
  before: readonly PlayerSnapshot[],
  patches: readonly PlayerPatch[]
): readonly PlayerSnapshot[] {
  const byId = new Map(patches.map((patch) => [patch.playerId, patch]));
  if (
    byId.size !== patches.length ||
    patches.some((patch) =>
      !before.some((player) => player.playerId === patch.playerId)
    )
  ) throw new RangeError("Invalid match delta player.");
  return Object.freeze(before.map((player) => {
    const patch = byId.get(player.playerId);
    return patch === undefined ? player : applyPatch(player, patch);
  }));
}
