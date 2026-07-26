import type { RoomCommand } from "../../../packages/room-core/src/model.ts";
import type {
  RoomActorPrincipal,
  RoomUserCommand
} from "./roomActor.ts";

export function mapRoomUserCommand(
  principal: RoomActorPrincipal,
  command: RoomUserCommand,
  atMs: number
): RoomCommand {
  switch (command.type) {
    case "member.join":
      return {
        type: "member.join",
        requestId: command.requestId,
        player: principal.player,
        connectionId: principal.connectionId,
        participation: command.participation,
        ...(command.preferredSeat === undefined
          ? {}
          : { preferredSeat: command.preferredSeat }),
        atMs
      };
    case "member.leave":
      return {
        type: "member.leave",
        requestId: command.requestId,
        actorPlayerId: principal.player.playerId,
        expectedRevision: command.expectedRevision,
        atMs
      };
    case "seat.set":
      return {
        type: "seat.set",
        requestId: command.requestId,
        actorPlayerId: principal.player.playerId,
        expectedRevision: command.expectedRevision,
        seat: command.seat,
        atMs
      };
    case "ready.set":
      return {
        type: "ready.set",
        requestId: command.requestId,
        actorPlayerId: principal.player.playerId,
        expectedRevision: command.expectedRevision,
        ready: command.ready,
        atMs
      };
    case "settings.update":
      return {
        type: "settings.update",
        requestId: command.requestId,
        actorPlayerId: principal.player.playerId,
        expectedRevision: command.expectedRevision,
        patch: command.patch,
        atMs
      };
    case "host.transfer":
      return {
        type: "host.transfer",
        requestId: command.requestId,
        actorPlayerId: principal.player.playerId,
        expectedRevision: command.expectedRevision,
        targetPlayerId: command.targetPlayerId,
        atMs
      };
    case "member.kick":
      return {
        type: "member.kick",
        requestId: command.requestId,
        actorPlayerId: principal.player.playerId,
        expectedRevision: command.expectedRevision,
        targetPlayerId: command.targetPlayerId,
        atMs
      };
    case "series.rematch":
      return {
        type: "series.rematch",
        requestId: command.requestId,
        actorPlayerId: principal.player.playerId,
        expectedRevision: command.expectedRevision,
        accepted: command.accepted,
        atMs
      };
    case "room.close":
      return {
        type: "room.close",
        requestId: command.requestId,
        actorPlayerId: principal.player.playerId,
        expectedRevision: command.expectedRevision,
        atMs
      };
  }
}
