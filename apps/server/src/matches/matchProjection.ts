import { createHash } from "node:crypto";

import type { PlayerSimulationView } from "../../../../packages/game-core/src/playerSimulationTypes.ts";
import type {
  InputAcknowledgement,
  MatchServerMessage,
  PlayerSnapshot,
  PrivateSimulationSnapshot
} from "../../../../packages/protocol/src/matchMessages.ts";
import type { MatchCoordinatorView } from "./matchCoordinatorTypes.ts";

function publicPlayer(view: PlayerSimulationView): PlayerSnapshot {
  return Object.freeze({
    playerId: view.playerId,
    boardRows: Object.freeze([...view.board.rows]),
    garbageRows: Object.freeze([...view.board.garbageRows]),
    active: view.active,
    hold: view.hold,
    next: view.next,
    combo: view.combo,
    backToBack: view.backToBack,
    piecesPlaced: view.piecesPlaced,
    totalAttackSent: view.totalAttackSent,
    pendingGarbage: Object.freeze(view.pendingGarbage.map((packet) =>
      Object.freeze({
        packetId: packet.packetId,
        sourcePlayerId: packet.sourcePlayerId,
        amount: packet.amount,
        appliesAtFrame: packet.appliesAtFrame
      })
    )),
    toppedOut: view.toppedOut
  });
}

function privatePlayer(view: PlayerSimulationView): PrivateSimulationSnapshot {
  return Object.freeze({
    playerId: view.playerId,
    pieceCursor: view.pieceCursor,
    pieceWindow: view.next,
    heldInputMask: view.heldInputMask,
    dasFrames: view.dasFrames,
    arrFrames: view.rules.arrFrames,
    gravity256: Math.round(
      (view.rules.gravityMicrosPerSecond * 256) /
        (view.rules.tickRateHz * 1_000_000)
    ),
    lockFrames: view.lockFrames,
    lockResets: view.lockResets,
    canHold: view.canHold,
    pendingGarbage: Object.freeze(view.pendingGarbage.map((packet) =>
      Object.freeze({
        packetId: packet.packetId,
        sourcePlayerId: packet.sourcePlayerId,
        amount: packet.amount,
        appliesAtFrame: packet.appliesAtFrame,
        holeSeed: packet.hole
      })
    ))
  });
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function publicMatchState(
  coordinator: MatchCoordinatorView
): readonly PlayerSnapshot[] {
  return Object.freeze(
    coordinator.simulations.map((simulation) => publicPlayer(simulation.view))
  );
}

export function selfStateHash(
  coordinator: MatchCoordinatorView,
  playerId: string
): string {
  const simulation = coordinator.simulations.find(
    (candidate) => candidate.view.playerId === playerId
  );
  if (simulation === undefined) throw new RangeError("Player is not in match.");
  return hash({
    serverFrame: coordinator.serverFrame,
    public: publicPlayer(simulation.view),
    private: privatePlayer(simulation.view)
  });
}

export function projectMatchSnapshot(
  coordinator: MatchCoordinatorView,
  viewerPlayerId: string,
  acknowledgement?: InputAcknowledgement
): Extract<MatchServerMessage, { readonly type: "match.snapshot" }> {
  const players = publicMatchState(coordinator);
  const own = coordinator.simulations.find(
    (simulation) => simulation.view.playerId === viewerPlayerId
  );
  const self = own === undefined ? null : privatePlayer(own.view);
  return {
    type: "match.snapshot",
    matchId: coordinator.matchId,
    stateSequence: coordinator.stateSequence,
    lastEventSequence: coordinator.lastEventSequence,
    serverFrame: coordinator.serverFrame,
    publicStateHash: hash(players),
    selfStateHash:
      own === undefined ? null : selfStateHash(coordinator, viewerPlayerId),
    players,
    self,
    ...(acknowledgement === undefined ? {} : { acknowledgement })
  };
}
