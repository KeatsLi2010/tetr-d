import {
  boardAsPlayfield,
  createBoard,
  findPieceSpawnPlacement,
  isPiecePlacementValid,
  lockPiece,
  tryRotate,
  type ActivePiece,
  type Board,
  type PieceKind,
  type RotationDirection,
  type SimulationInputAction
} from "@tetr-d/game-core";
import type {
  PendingGarbagePacket,
  PlayerSnapshot,
  PrivateSimulationSnapshot
} from "@tetr-d/protocol";

export interface NetworkPlayerState {
  readonly playerId: string;
  readonly board: Board;
  readonly active: ActivePiece | null;
  readonly hold: PieceKind | null;
  readonly next: readonly PieceKind[];
  readonly pieceCursor: number;
  readonly combo: number;
  readonly backToBack: number;
  readonly piecesPlaced: number;
  readonly totalAttackSent: number;
  readonly pendingGarbage: readonly PendingGarbagePacket[];
  readonly canHold: boolean;
  readonly toppedOut: boolean;
}

function asActivePiece(active: PlayerSnapshot["active"]): ActivePiece | null {
  if (active === null) return null;
  if (
    active.rotation !== 0 &&
    active.rotation !== 1 &&
    active.rotation !== 2 &&
    active.rotation !== 3
  ) return null;
  return { ...active, rotation: active.rotation };
}

export function networkPlayerState(
  snapshot: PlayerSnapshot,
  own: PrivateSimulationSnapshot | null
): NetworkPlayerState {
  return Object.freeze({
    playerId: snapshot.playerId,
    board: createBoard(snapshot.boardRows, snapshot.garbageRows),
    active: asActivePiece(snapshot.active),
    hold: snapshot.hold,
    next: Object.freeze([...snapshot.next]),
    pieceCursor:
      own?.playerId === snapshot.playerId ? own.pieceCursor : 0,
    combo: snapshot.combo,
    backToBack: snapshot.backToBack,
    piecesPlaced: snapshot.piecesPlaced,
    totalAttackSent: snapshot.totalAttackSent,
    pendingGarbage: Object.freeze([...snapshot.pendingGarbage]),
    canHold:
      own?.playerId === snapshot.playerId ? own.canHold : true,
    toppedOut: snapshot.toppedOut
  });
}

function moveVertical(
  board: Board,
  piece: ActivePiece,
  cells: number
): ActivePiece {
  let moved = piece;
  for (let remaining = cells; remaining > 0; remaining -= 1) {
    const candidate = { ...moved, y: moved.y - 1 };
    if (!isPiecePlacementValid(board, candidate)) break;
    moved = candidate;
  }
  return moved;
}

function spawnAfterDraw(
  state: NetworkPlayerState,
  board: Board,
  allowClutchLift: boolean
): NetworkPlayerState {
  const kind = state.next[0];
  if (kind === undefined) {
    return { ...state, board, active: null, toppedOut: true };
  }
  const placement = findPieceSpawnPlacement({
    board,
    kind,
    spawnX: 3,
    spawnY: 17,
    allowClutchLift
  });
  return {
    ...state,
    board,
    active: placement?.piece ?? null,
    next: Object.freeze(state.next.slice(1)),
    pieceCursor: state.pieceCursor + 1,
    canHold: true,
    toppedOut: placement === null
  };
}

function predictHardDrop(state: NetworkPlayerState): NetworkPlayerState {
  if (state.active === null) return state;
  const landed = moveVertical(state.board, state.active, 40);
  const locked = lockPiece(state.board, landed);
  const afterLock: NetworkPlayerState = {
    ...state,
    active: null,
    piecesPlaced: state.piecesPlaced + 1,
    combo: locked.clearedLineCount > 0 ? state.combo + 1 : -1
  };
  return spawnAfterDraw(
    afterLock,
    locked.board,
    locked.clearedLineCount > 0
  );
}

function predictHold(state: NetworkPlayerState): NetworkPlayerState {
  if (!state.canHold || state.active === null) return state;
  const current = state.active.kind;
  const replacement = state.hold ?? state.next[0];
  if (replacement === undefined) return state;
  const consumedNext = state.hold === null;
  const placement = findPieceSpawnPlacement({
    board: state.board,
    kind: replacement,
    spawnX: 3,
    spawnY: 17,
    allowClutchLift: false
  });
  return {
    ...state,
    active: placement?.piece ?? null,
    hold: current,
    next: consumedNext
      ? Object.freeze(state.next.slice(1))
      : state.next,
    pieceCursor: state.pieceCursor + (consumedNext ? 1 : 0),
    canHold: false,
    toppedOut: placement === null
  };
}

function predictAction(
  state: NetworkPlayerState,
  action: SimulationInputAction
): NetworkPlayerState {
  const active = state.active;
  if (active === null || state.toppedOut) return state;
  if (action.kind === "hardDrop") return predictHardDrop(state);
  if (action.kind === "hold") return predictHold(state);
  if (action.kind === "rotate") {
    const result = tryRotate(
      boardAsPlayfield(state.board),
      active,
      action.direction
    );
    return result.success ? { ...state, active: result.piece } : state;
  }
  if (action.kind === "sonicDrop") {
    return { ...state, active: moveVertical(state.board, active, 40) };
  }
  if (action.kind === "softDropStep") {
    return {
      ...state,
      active: moveVertical(state.board, active, action.cells)
    };
  }
  if (action.kind === "moveStep" || action.kind === "moveToWall") {
    const delta = action.direction === "left" ? -1 : 1;
    let moved = active;
    do {
      const candidate = { ...moved, x: moved.x + delta };
      if (!isPiecePlacementValid(state.board, candidate)) break;
      moved = candidate;
    } while (action.kind === "moveToWall");
    return moved === active ? state : { ...state, active: moved };
  }
  if (action.kind === "move" && action.pressed) {
    const candidate = {
      ...active,
      x: active.x + (action.direction === "left" ? -1 : 1)
    };
    return isPiecePlacementValid(state.board, candidate)
      ? { ...state, active: candidate }
      : state;
  }
  return state;
}

export type PredictedSpawnCause = "hardDrop" | "hold";

export interface PredictedPlayerActions {
  readonly state: NetworkPlayerState;
  readonly spawnCauses: readonly PredictedSpawnCause[];
}

export function predictPlayerActions(
  initial: NetworkPlayerState,
  actions: readonly SimulationInputAction[]
): PredictedPlayerActions {
  let state = initial;
  const spawnCauses: PredictedSpawnCause[] = [];
  let generationPending = false;
  let bufferedHold = false;
  let bufferedRotation: RotationDirection | null = null;
  const finishGeneration = () => {
    if (!generationPending) return;
    if (bufferedHold) state = predictHold(state);
    if (bufferedRotation !== null) {
      state = predictAction(state, {
        kind: "rotate",
        direction: bufferedRotation
      });
    }
    generationPending = false;
    bufferedHold = false;
    bufferedRotation = null;
  };
  for (const action of actions) {
    if (
      generationPending &&
      (action.kind === "hold" || action.kind === "rotate")
    ) {
      if (action.kind === "hold") bufferedHold = true;
      else bufferedRotation = action.direction;
      continue;
    }
    finishGeneration();
    const previous = state;
    state = predictAction(state, action);
    if (
      action.kind === "hardDrop" &&
      state.piecesPlaced > previous.piecesPlaced
    ) {
      spawnCauses.push("hardDrop");
    } else if (
      action.kind === "hold" &&
      previous.canHold &&
      !state.canHold &&
      state.active !== previous.active
    ) {
      spawnCauses.push("hold");
    }
    if (
      (action.kind === "hardDrop" && state.piecesPlaced > previous.piecesPlaced)
      || (action.kind === "hold" && state.canHold === false && state.active !== previous.active)
    ) {
      generationPending = true;
    }
  }
  finishGeneration();
  return Object.freeze({
    state: Object.freeze(state),
    spawnCauses: Object.freeze(spawnCauses)
  });
}

export function applyPredictedActions(
  initial: NetworkPlayerState,
  actions: readonly SimulationInputAction[]
): NetworkPlayerState {
  return predictPlayerActions(initial, actions).state;
}
