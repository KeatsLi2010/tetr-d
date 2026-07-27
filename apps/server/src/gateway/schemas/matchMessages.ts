import { z } from "zod";

import {
  matchIdSchema,
  nonnegativeIntegerSchema,
  requestIdSchema,
  revisionSchema,
  roomIdSchema
} from "./primitives.ts";

const actionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("move"),
      direction: z.enum(["left", "right"]),
      pressed: z.boolean()
    })
    .strict(),
  z
    .object({
      kind: z.literal("moveStep"),
      direction: z.enum(["left", "right"])
    })
    .strict(),
  z
    .object({
      kind: z.literal("moveToWall"),
      direction: z.enum(["left", "right"])
    })
    .strict(),
  z.object({ kind: z.literal("softDrop"), pressed: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("softDropStep"),
      cells: z.number().int().min(1).max(40)
    })
    .strict(),
  z.object({ kind: z.literal("sonicDrop") }).strict(),
  z.object({ kind: z.literal("clearHeld") }).strict(),
  z.object({ kind: z.literal("hardDrop") }).strict(),
  z
    .object({
      kind: z.literal("rotate"),
      direction: z.enum(["cw", "ccw", "180"])
    })
    .strict(),
  z.object({ kind: z.literal("hold") }).strict()
]);

export const matchForfeitMessageSchema = z
  .object({
    type: z.literal("match.forfeit"),
    requestId: requestIdSchema,
    roomId: roomIdSchema,
    matchId: matchIdSchema,
    expectedRevision: revisionSchema
  })
  .strict();

export const matchInputMessageSchema = z
  .object({
    type: z.literal("match.input"),
    matchId: matchIdSchema,
    inputEpoch: nonnegativeIntegerSchema,
    sequence: nonnegativeIntegerSchema,
    clientFrame: nonnegativeIntegerSchema,
    actions: z.array(actionSchema).min(1).max(16)
  })
  .strict();

export const matchResyncMessageSchema = z
  .object({
    type: z.literal("match.resyncRequest"),
    matchId: matchIdSchema,
    lastStateSequence: nonnegativeIntegerSchema,
    lastEventSequence: nonnegativeIntegerSchema
  })
  .strict();

const feedbackChannelSchema = z
  .object({
    strength: z.number().int().min(0).max(200),
    limit: z.number().int().min(0).max(200)
  })
  .strict();

export const matchFeedbackMessageSchema = z
  .object({
    type: z.literal("match.feedback"),
    matchId: matchIdSchema,
    visible: z.boolean(),
    connected: z.boolean(),
    armed: z.boolean(),
    channelA: feedbackChannelSchema,
    channelB: feedbackChannelSchema
  })
  .strict();

export const matchClientMessageSchema = z.discriminatedUnion("type", [
  matchForfeitMessageSchema,
  matchInputMessageSchema,
  matchResyncMessageSchema,
  matchFeedbackMessageSchema
]);
