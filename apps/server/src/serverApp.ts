import { createServer } from "node:http";
import { isIP, type AddressInfo } from "node:net";

import {
  PIECE_SEQUENCE_VERSION,
  PROTOCOL_VERSION,
  ROTATION_SYSTEM_VERSION,
  RULESET_VERSION
} from "../../../packages/protocol/src/messages.ts";
import { SessionStore } from "./auth/sessionStore.ts";
import { ConnectionHub } from "./gateway/connectionHub.ts";
import { RealtimeService } from "./gateway/realtimeService.ts";
import { WebSocketGateway } from "./gateway/webSocketGateway.ts";
import {
  DEFAULT_MATCH_TICK_RATE_HZ,
  MAX_MATCH_TICK_RATE_HZ,
  MIN_MATCH_TICK_RATE_HZ
} from "./matches/matchTiming.ts";
import { MatchMessageService } from "./matches/matchMessageService.ts";
import { MatchRegistry } from "./matches/matchRegistry.ts";
import { RoomEffectProcessor } from "./rooms/roomEffectProcessor.ts";
import { RoomManager } from "./rooms/roomManager.ts";
import { createStaticWebHandler } from "./staticWeb.ts";

export type ServerEnvironment = "development" | "production";

export interface TetrServerOptions {
  readonly buildId?: string;
  readonly environment?: ServerEnvironment;
  readonly allowedOrigins?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly allowUnsafeDevelopmentAccess?: boolean;
  readonly sessionHmacKey?: Uint8Array;
  readonly now?: () => number;
  readonly heartbeatMs?: number;
  readonly helloTimeoutMs?: number;
  readonly maxPendingMessages?: number;
  readonly maxConnections?: number;
  readonly maxConnectionsPerIp?: number;
  readonly matchTickRateHz?: number;
  readonly replayRootDirectory?: string;
  readonly shutdownGraceMs?: number;
  readonly webRoot?: string;
  readonly onError?: (error: unknown) => void;
}

export interface ListenOptions {
  readonly host: string;
  readonly port: number;
}

export interface TetrServerApp {
  readonly server: ReturnType<typeof createServer>;
  readonly sessions: SessionStore;
  readonly connections: ConnectionHub;
  readonly rooms: RoomManager;
  readonly matches: MatchRegistry;
  readonly effects: RoomEffectProcessor;
  readonly service: RealtimeService;
  readonly gateway: WebSocketGateway;
  listen(options: ListenOptions): Promise<AddressInfo>;
  close(): Promise<void>;
}

function safeReport(
  onError: (error: unknown) => void,
  error: unknown
): void {
  try {
    onError(error);
  } catch {
    // Logging is a terminal boundary.
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split(".")[0] === "127";
}

function closeHttpServer(
  server: ReturnType<typeof createServer>
): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

export function createTetrServer(
  options: TetrServerOptions = {}
): TetrServerApp {
  const buildId = options.buildId ?? "dev";
  const environment = options.environment ?? "development";
  const allowUnsafeDevelopmentAccess =
    options.allowUnsafeDevelopmentAccess === true;
  if (environment !== "development" && environment !== "production") {
    throw new TypeError("Invalid server environment.");
  }
  if (environment === "production" && allowUnsafeDevelopmentAccess) {
    throw new TypeError("Open WebSocket access is forbidden in production.");
  }
  if (environment === "production" && options.sessionHmacKey === undefined) {
    throw new TypeError("SESSION_HMAC_KEY is required in production.");
  }
  if (
    !allowUnsafeDevelopmentAccess &&
    ((options.allowedOrigins?.length ?? 0) === 0 ||
      (options.allowedHosts?.length ?? 0) === 0)
  ) {
    throw new TypeError("WebSocket Origin and Host allowlists are required.");
  }

  const now = options.now ?? Date.now;
  const onError = options.onError ?? (() => undefined);
  const matchTickRateHz =
    options.matchTickRateHz ?? DEFAULT_MATCH_TICK_RATE_HZ;
  if (
    !Number.isSafeInteger(matchTickRateHz) ||
    matchTickRateHz < MIN_MATCH_TICK_RATE_HZ ||
    matchTickRateHz > MAX_MATCH_TICK_RATE_HZ
  ) {
    throw new TypeError("Invalid match tick rate.");
  }
  const startedAt = new Date(now()).toISOString();
  const sessions = new SessionStore({
    now,
    ...(options.sessionHmacKey === undefined
      ? {}
      : { hmacKey: options.sessionHmacKey })
  });
  const connections = new ConnectionHub();
  let effects: RoomEffectProcessor | null = null;
  let rooms: RoomManager;
  const matches = new MatchRegistry({
    sessions,
    connections,
    tickRateHz: matchTickRateHz,
    ...(options.replayRootDirectory === undefined
      ? {} : { replayRootDirectory: options.replayRootDirectory }),
    serverVersion: buildId,
    now,
    getRoomState(roomId) {
      return rooms.getById(roomId)?.state ?? null;
    },
    async onMatchFinished(result) {
      const dispatched = rooms.dispatchSystem(result.roomId, {
        type: "match.finished",
        matchId: result.matchId,
        winnerPlayerId: result.winnerPlayerId,
        reason: result.reason,
        serverFrame: result.serverFrame
      });
      if (dispatched !== null) await dispatched;
    },
    onError(error) {
      safeReport(onError, error);
    }
  });
  rooms = new RoomManager({
    now,
    isPrincipalCurrent: (principal) =>
      sessions.isCurrentConnection(
        principal.sessionId,
        principal.connectionId,
        principal.connectionGeneration
      ),
    async onCommit(_roomId, commit) {
      const processor = effects;
      if (processor === null) {
        throw new Error("Effect processor is not ready.");
      }
      await processor.enqueueDurably(commit);
    },
    onError
  });
  effects = new RoomEffectProcessor({
    sessions,
    connections,
    matches,
    matchTickRateHz,
    getRoomState(roomId) {
      return rooms.getById(roomId)?.state ?? null;
    },
    removeRoom(roomId) {
      return rooms.getById(roomId) === null || rooms.remove(roomId);
    },
    onError(error) {
      safeReport(onError, error);
    }
  });
  const matchMessages = new MatchMessageService({
    sessions,
    connections,
    rooms,
    matches
  });
  const service = new RealtimeService({
    sessions,
    connections,
    rooms,
    matchMessages,
    replayMatchStartForPlayer(playerId) {
      effects?.replayMatchStartForPlayer(playerId);
    },
    onError
  });
  const staticWeb = options.webRoot === undefined
    ? null
    : createStaticWebHandler({ webRoot: options.webRoot });

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/health") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(
        JSON.stringify({
          ok: true,
          service: "tetr-d-server",
          buildId,
          protocolVersion: PROTOCOL_VERSION,
          rotationSystemVersion: ROTATION_SYSTEM_VERSION,
          pieceSequenceVersion: PIECE_SEQUENCE_VERSION,
          rulesetVersion: RULESET_VERSION,
          matchTickRateHz,
          startedAt
        })
      );
      return;
    }
    if (staticWeb !== null) {
      void staticWeb(request, response)
        .then((handled) => {
          if (handled || response.writableEnded) return;
          response.writeHead(404, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store"
          });
          response.end(JSON.stringify({ error: "not_found" }));
        })
        .catch((error: unknown) => {
          safeReport(onError, error);
          if (response.headersSent) {
            response.destroy();
            return;
          }
          response.writeHead(500, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store"
          });
          response.end(JSON.stringify({ error: "internal_error" }));
        });
      return;
    }
    response.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  server.on("clientError", (error, socket) => {
    if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") {
      safeReport(onError, error);
    }
    socket.destroy();
  });

  const gateway = new WebSocketGateway({
    server,
    service,
    allowedOrigins: options.allowedOrigins ?? [],
    allowedHosts: options.allowedHosts ?? [],
    allowUnsafeDevelopmentAccess,
    ...(options.heartbeatMs === undefined
      ? {}
      : { heartbeatMs: options.heartbeatMs }),
    ...(options.helloTimeoutMs === undefined
      ? {}
      : { helloTimeoutMs: options.helloTimeoutMs }),
    ...(options.maxPendingMessages === undefined
      ? {}
      : { maxPendingMessages: options.maxPendingMessages }),
    ...(options.maxConnections === undefined
      ? {}
      : { maxConnections: options.maxConnections }),
    ...(options.maxConnectionsPerIp === undefined
      ? {}
      : { maxConnectionsPerIp: options.maxConnectionsPerIp }),
    ...(options.shutdownGraceMs === undefined
      ? {}
      : { shutdownGraceMs: options.shutdownGraceMs }),
    onError
  });
  let closing: Promise<void> | null = null;

  return Object.freeze({
    server,
    sessions,
    connections,
    rooms,
    matches,
    effects,
    service,
    gateway,
    listen({ host, port }: ListenOptions) {
      if (
        host.length === 0 ||
        host.trim() !== host ||
        !Number.isInteger(port) ||
        port < 0 ||
        port > 65_535
      ) {
        return Promise.reject(new RangeError("Invalid listen address."));
      }
      if (
        allowUnsafeDevelopmentAccess &&
        (environment === "production" || !isLoopbackHost(host))
      ) {
        return Promise.reject(
          new Error("Open development access requires a loopback listener.")
        );
      }
      return new Promise<AddressInfo>((resolve, reject) => {
        const onListenError = (error: Error) => reject(error);
        server.once("error", onListenError);
        server.listen(port, host, () => {
          server.off("error", onListenError);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Server did not expose a TCP address."));
            return;
          }
          resolve(address);
        });
      });
    },
    close() {
      if (closing !== null) return closing;
      closing = (async () => {
        const gatewayClosing = gateway.close();
        effects?.dispose();
        matches.dispose();
        rooms.dispose();
        const results = await Promise.allSettled([
          gatewayClosing,
          closeHttpServer(server)
        ]);
        const errors: unknown[] = [];
        for (const result of results) {
          if (result.status === "rejected") errors.push(result.reason);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, "Server shutdown failed.");
        }
      })();
      return closing;
    }
  });
}
