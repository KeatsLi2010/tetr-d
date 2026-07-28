import { z } from "zod";

import {
  requestIdSchema,
  revisionSchema,
  roomCodeSchema,
  roomIdSchema,
  seatSchema,
  settingsPatchSchema
} from "./primitives.ts";

const mutationFields = {
  requestId: requestIdSchema,
  roomId: roomIdSchema,
  expectedRevision: revisionSchema
};

export const roomCreateMessageSchema = z
  .object({
    type: z.literal("room.create"),
    requestId: requestIdSchema,
    roomCode: roomCodeSchema.optional(),
    settings: settingsPatchSchema.optional()
  })
  .strict();

export const roomJoinMessageSchema = z
  .object({
    type: z.literal("room.join"),
    requestId: requestIdSchema,
    roomCode: roomCodeSchema,
    participation: z.enum(["player", "spectator"]),
    preferredSeat: seatSchema.optional()
  })
  .strict();

export const roomLeaveMessageSchema = z
  .object({ type: z.literal("room.leave"), ...mutationFields })
  .strict();

export const roomSeatSetMessageSchema = z
  .object({
    type: z.literal("room.seat.set"),
    ...mutationFields,
    seat: seatSchema.nullable()
  })
  .strict();

export const roomReadySetMessageSchema = z
  .object({
    type: z.literal("room.ready.set"),
    ...mutationFields,
    ready: z.boolean()
  })
  .strict();

export const roomSettingsUpdateMessageSchema = z
  .object({
    type: z.literal("room.settings.update"),
    ...mutationFields,
    patch: settingsPatchSchema
  })
  .strict();

export const roomHostTransferMessageSchema = z
  .object({
    type: z.literal("room.host.transfer"),
    ...mutationFields,
    targetPlayerId: roomIdSchema
  })
  .strict();

export const roomMemberKickMessageSchema = z
  .object({
    type: z.literal("room.member.kick"),
    ...mutationFields,
    targetPlayerId: roomIdSchema
  })
  .strict();

export const roomSeriesRematchMessageSchema = z
  .object({
    type: z.literal("room.series.rematch"),
    ...mutationFields,
    accepted: z.boolean()
  })
  .strict();

export const roomCloseMessageSchema = z
  .object({ type: z.literal("room.close"), ...mutationFields })
  .strict();

export const roomClientMessageSchema = z.discriminatedUnion("type", [
  roomCreateMessageSchema,
  roomJoinMessageSchema,
  roomLeaveMessageSchema,
  roomSeatSetMessageSchema,
  roomReadySetMessageSchema,
  roomSettingsUpdateMessageSchema,
  roomHostTransferMessageSchema,
  roomMemberKickMessageSchema,
  roomSeriesRematchMessageSchema,
  roomCloseMessageSchema
]);
