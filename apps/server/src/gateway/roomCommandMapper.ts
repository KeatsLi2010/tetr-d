import type {
  RoomSettings
} from "../../../../packages/room-core/src/model.ts";
import type {
  RoomClientMessage
} from "../../../../packages/protocol/src/roomMessages.ts";
import type {
  RoomUserCommand
} from "../roomActor.ts";

export type RoomMutationUserCommand = Exclude<
  RoomUserCommand,
  { readonly type: "member.join" }
>;

export type RoomCommandMappingResult =
  | {
      readonly kind: "mapped";
      readonly roomId: string;
      readonly command: RoomMutationUserCommand;
    }
  | {
      readonly kind: "not_mappable";
      readonly messageType: RoomClientMessage["type"];
      readonly reason: "create_or_join" | "internal_field";
    };

const INTERNAL_COMMAND_FIELDS = [
  "actorPlayerId",
  "atMs",
  "player",
  "connectionId"
] as const;

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasInternalCommandField(message: RoomClientMessage): boolean {
  return INTERNAL_COMMAND_FIELDS.some((field) => hasOwn(message, field));
}

function mapSettingsPatch(
  patch: Partial<RoomSettings>
): Partial<RoomSettings> {
  const targetWins = patch.targetWins;
  const allowSpectators = patch.allowSpectators;
  if (targetWins !== undefined && allowSpectators !== undefined) {
    return { targetWins, allowSpectators };
  }
  if (targetWins !== undefined) return { targetWins };
  if (allowSpectators !== undefined) return { allowSpectators };
  return {};
}

function mapped(
  roomId: string,
  command: RoomMutationUserCommand
): RoomCommandMappingResult {
  return { kind: "mapped", roomId, command };
}

function notMappable(
  messageType: RoomClientMessage["type"],
  reason: "create_or_join" | "internal_field"
): RoomCommandMappingResult {
  return { kind: "not_mappable", messageType, reason };
}

function assertNever(value: never): never {
  throw new TypeError(
    `Unhandled room client message: ${String(
      (value as { readonly type?: unknown }).type
    )}`
  );
}

export function mapRoomClientMessageToUserCommand(
  message: RoomClientMessage
): RoomCommandMappingResult {
  if (hasInternalCommandField(message)) {
    return notMappable(message.type, "internal_field");
  }

  switch (message.type) {
    case "room.create":
    case "room.join":
      return notMappable(message.type, "create_or_join");
    case "room.leave":
      return mapped(message.roomId, {
        type: "member.leave",
        requestId: message.requestId,
        expectedRevision: message.expectedRevision
      });
    case "room.seat.set":
      return mapped(message.roomId, {
        type: "seat.set",
        requestId: message.requestId,
        expectedRevision: message.expectedRevision,
        seat: message.seat
      });
    case "room.ready.set":
      return mapped(message.roomId, {
        type: "ready.set",
        requestId: message.requestId,
        expectedRevision: message.expectedRevision,
        ready: message.ready
      });
    case "room.settings.update":
      return mapped(message.roomId, {
        type: "settings.update",
        requestId: message.requestId,
        expectedRevision: message.expectedRevision,
        patch: mapSettingsPatch(message.patch)
      });
    case "room.host.transfer":
      return mapped(message.roomId, {
        type: "host.transfer",
        requestId: message.requestId,
        expectedRevision: message.expectedRevision,
        targetPlayerId: message.targetPlayerId
      });
    case "room.member.kick":
      return mapped(message.roomId, {
        type: "member.kick",
        requestId: message.requestId,
        expectedRevision: message.expectedRevision,
        targetPlayerId: message.targetPlayerId
      });
    case "room.series.rematch":
      return mapped(message.roomId, {
        type: "series.rematch",
        requestId: message.requestId,
        expectedRevision: message.expectedRevision,
        accepted: message.accepted
      });
    case "room.close":
      return mapped(message.roomId, {
        type: "room.close",
        requestId: message.requestId,
        expectedRevision: message.expectedRevision
      });
  }
  return assertNever(message);
}
