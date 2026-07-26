import { Buffer } from "node:buffer";
import { statSync } from "node:fs";
import { resolve } from "node:path";

import { createTetrServer } from "./serverApp.ts";
import type { ServerEnvironment } from "./serverApp.ts";
import { parseMatchTickRateHz } from "./matches/matchTiming.ts";

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid PORT: ${value}`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function parseList(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  return Object.freeze(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  );
}

function parseBoolean(
  value: string | undefined,
  name: string
): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false.`);
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid ${name}: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

function parseSessionKey(value: string | undefined): Uint8Array | undefined {
  if (value === undefined || value === "") return undefined;
  const bytes = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64url");
  if (bytes.byteLength < 32) {
    throw new Error("SESSION_HMAC_KEY must contain at least 32 bytes.");
  }
  return bytes;
}

function existingDirectory(path: string): string | undefined {
  try {
    return statSync(path).isDirectory() ? path : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

const host = process.env.HOST ?? "127.0.0.1";
const port = parsePort(process.env.PORT ?? "4180");
const buildId = process.env.BUILD_ID ?? "dev";
const environment: ServerEnvironment =
  process.env.NODE_ENV === "production" ? "production" : "development";
const allowedOrigins = parseList(process.env.WS_ALLOWED_ORIGINS);
const allowedHosts = parseList(process.env.WS_ALLOWED_HOSTS);
const allowUnsafeDevelopmentAccess = parseBoolean(
  process.env.WS_ALLOW_INSECURE_DEVELOPMENT,
  "WS_ALLOW_INSECURE_DEVELOPMENT"
);
const maxConnections = parsePositiveInteger(
  process.env.WS_MAX_CONNECTIONS,
  1_024,
  "WS_MAX_CONNECTIONS"
);
const maxConnectionsPerIp = parsePositiveInteger(
  process.env.WS_MAX_CONNECTIONS_PER_IP,
  64,
  "WS_MAX_CONNECTIONS_PER_IP"
);
const shutdownGraceMs = parsePositiveInteger(
  process.env.WS_SHUTDOWN_GRACE_MS,
  5_000,
  "WS_SHUTDOWN_GRACE_MS"
);
const sessionHmacKey = parseSessionKey(process.env.SESSION_HMAC_KEY);
const matchTickRateHz = parseMatchTickRateHz(
  process.env.MATCH_TICK_RATE_HZ
);
const webRoot = existingDirectory(
  resolve(process.cwd(), "apps", "web", "dist")
);
const replayRootDirectory = resolve(
  process.env.MATCH_REPLAY_DIR
    ?? resolve(process.cwd(), "data", "replays")
);

const app = createTetrServer({
  buildId,
  environment,
  allowedOrigins,
  allowedHosts,
  allowUnsafeDevelopmentAccess,
  maxConnections,
  maxConnectionsPerIp,
  matchTickRateHz,
  replayRootDirectory,
  shutdownGraceMs,
  ...(sessionHmacKey === undefined ? {} : { sessionHmacKey }),
  ...(webRoot === undefined ? {} : { webRoot }),
  onError(error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "server.runtime_error",
        message: error instanceof Error ? error.message : String(error)
      })
    );
  }
});

await app.listen({ host, port });
console.log(
  JSON.stringify({
    level: "info",
    event: "server.listening",
    host,
    port,
    buildId,
    websocketPath: "/ws",
    accessPolicy: allowUnsafeDevelopmentAccess
      ? "insecure-loopback-development"
      : "origin-and-host-allowlists",
    maxConnections,
    maxConnectionsPerIp,
    matchTickRateHz,
    webRoot: webRoot ?? null
  })
);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(
    JSON.stringify({ level: "info", event: "server.stopping", signal })
  );
  try {
    await app.close();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "server.stop_failed",
        message: error instanceof Error ? error.message : String(error)
      })
    );
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
