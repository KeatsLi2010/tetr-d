import { createHmac, randomBytes } from "node:crypto";

export const RESUME_TOKEN_PREFIX = "rt1.";
export const RESUME_TOKEN_BYTES = 32;

const RESUME_TOKEN_PATTERN = /^rt1\.[A-Za-z0-9_-]{43}$/;

export type RandomByteSource = (size: number) => Uint8Array;

export function createResumeToken(
  randomByteSource: RandomByteSource = randomBytes
): string {
  const bytes = randomByteSource(RESUME_TOKEN_BYTES);
  if (bytes.byteLength !== RESUME_TOKEN_BYTES) {
    throw new RangeError("Resume token source returned the wrong byte count.");
  }
  return `${RESUME_TOKEN_PREFIX}${Buffer.from(bytes).toString("base64url")}`;
}

export function isResumeToken(value: unknown): value is string {
  return typeof value === "string" && RESUME_TOKEN_PATTERN.test(value);
}

export function digestResumeToken(
  token: string,
  hmacKey: Uint8Array
): string {
  if (!isResumeToken(token)) {
    throw new TypeError("Invalid resume token.");
  }
  if (hmacKey.byteLength < 32) {
    throw new RangeError("Resume token HMAC key must contain at least 32 bytes.");
  }
  return createHmac("sha256", hmacKey).update(token, "utf8").digest("base64url");
}
