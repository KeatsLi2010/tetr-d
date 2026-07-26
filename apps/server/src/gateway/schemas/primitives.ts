import { z } from "zod";

export const requestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/);
export const roomIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const matchIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const roomCodeSchema = z
  .string()
  .regex(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/i);
export const safeIntegerSchema = z.number().int().safe();
export const nonnegativeIntegerSchema = safeIntegerSchema.nonnegative();
export const revisionSchema = nonnegativeIntegerSchema;
export const seatSchema = z.union([z.literal(0), z.literal(1)]);
export const targetWinsSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5)
]);

export const settingsPatchSchema = z
  .object({
    targetWins: targetWinsSchema.optional(),
    allowSpectators: z.boolean().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Settings patch cannot be empty."
  });
