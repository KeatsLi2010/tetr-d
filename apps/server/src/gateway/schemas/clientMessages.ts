import { z } from "zod";

import type { ClientMessage } from "../../../../../packages/protocol/src/messages.ts";
import { matchClientMessageSchema } from "./matchMessages.ts";
import { roomClientMessageSchema } from "./roomMessages.ts";
import {
  authGuestMessageSchema,
  helloMessageSchema,
  pingMessageSchema
} from "./sessionMessages.ts";

export const clientMessageSchema = z.union([
  helloMessageSchema,
  authGuestMessageSchema,
  pingMessageSchema,
  roomClientMessageSchema,
  matchClientMessageSchema
]);

export function parseClientMessage(value: unknown): ClientMessage | null {
  const parsed = clientMessageSchema.safeParse(value);
  return parsed.success ? (parsed.data as ClientMessage) : null;
}
