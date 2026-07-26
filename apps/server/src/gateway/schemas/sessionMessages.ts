import { z } from "zod";

import { nonnegativeIntegerSchema } from "./primitives.ts";

export const helloMessageSchema = z
  .object({
    type: z.literal("hello"),
    protocolVersion: nonnegativeIntegerSchema,
    buildId: z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/),
    resumeToken: z
      .string()
      .regex(/^rt1\.[A-Za-z0-9_-]{43}$/)
      .optional()
  })
  .strict();

export const authGuestMessageSchema = z
  .object({
    type: z.literal("auth.guest"),
    displayName: z.string().min(1).max(96)
  })
  .strict();

export const pingMessageSchema = z
  .object({
    type: z.literal("ping"),
    clientTime: z.number().finite()
  })
  .strict();
