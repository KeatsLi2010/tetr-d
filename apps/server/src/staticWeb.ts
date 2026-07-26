import {
  createReadStream,
  realpathSync,
  statSync,
  type Stats
} from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse
} from "node:http";
import {
  extname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { pipeline } from "node:stream/promises";

export interface StaticWebOptions {
  readonly webRoot: string;
}

export type StaticWebHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<boolean>;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'"
].join("; ");

const SECURITY_HEADERS: Readonly<OutgoingHttpHeaders> = Object.freeze({
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
});

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8"
});

const IMMUTABLE_ASSET =
  /[.-][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u;
const FORBIDDEN_PATH_CHARACTERS = /[<>:"\\|?*\u0000-\u001f\u007f]/u;

interface StaticFile {
  readonly path: string;
  readonly stats: Stats;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot)
    )
  );
}

function requestPath(url: string | undefined): readonly string[] | null {
  if (url === undefined || !url.startsWith("/")) return null;
  const queryIndex = url.indexOf("?");
  const fragmentIndex = url.indexOf("#");
  const end = [queryIndex, fragmentIndex]
    .filter((index) => index >= 0)
    .reduce((smallest, index) => Math.min(smallest, index), url.length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.slice(0, end));
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || FORBIDDEN_PATH_CHARACTERS.test(decoded)) {
    return null;
  }
  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".")
    )
  ) {
    return null;
  }
  return Object.freeze(segments);
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function regularFile(
  root: string,
  candidate: string
): Promise<StaticFile | null> {
  if (!isWithinRoot(root, candidate)) return null;
  try {
    const actualPath = await realpath(candidate);
    if (!isWithinRoot(root, actualPath)) return null;
    const stats = await stat(actualPath);
    if (!stats.isFile()) return null;
    return Object.freeze({ path: actualPath, stats });
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function acceptsSpaFallback(
  request: IncomingMessage,
  segments: readonly string[]
): boolean {
  const pathname = `/${segments.join("/")}`;
  if (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/ws" ||
    pathname.startsWith("/ws/")
  ) {
    return false;
  }
  const lastSegment = segments.at(-1);
  if (lastSegment !== undefined && extname(lastSegment) !== "") return false;
  const accept = request.headers.accept;
  return (
    accept === undefined ||
    accept.includes("text/html") ||
    accept.includes("*/*")
  );
}

function contentType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ??
    "application/octet-stream";
}

function cacheControl(filePath: string): string {
  if (extname(filePath).toLowerCase() === ".html") return "no-cache";
  if (IMMUTABLE_ASSET.test(filePath.split(/[\\/]/u).at(-1) ?? "")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

function entityTag(stats: Stats): string {
  return `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
}

function isNotModified(request: IncomingMessage, file: StaticFile): boolean {
  const etag = entityTag(file.stats);
  const ifNoneMatch = request.headers["if-none-match"];
  if (ifNoneMatch !== undefined) {
    const values = Array.isArray(ifNoneMatch) ? ifNoneMatch : [ifNoneMatch];
    return values.some((value) =>
      value.split(",").some((candidate: string) => {
        const normalized = candidate.trim();
        return normalized === "*" || normalized === etag;
      })
    );
  }
  const ifModifiedSince = request.headers["if-modified-since"];
  if (ifModifiedSince === undefined || Array.isArray(ifModifiedSince)) {
    return false;
  }
  const timestamp = Date.parse(ifModifiedSince);
  return Number.isFinite(timestamp) &&
    Math.floor(file.stats.mtimeMs / 1_000) * 1_000 <= timestamp;
}

function fileHeaders(file: StaticFile): OutgoingHttpHeaders {
  return {
    ...SECURITY_HEADERS,
    "cache-control": cacheControl(file.path),
    "content-type": contentType(file.path),
    etag: entityTag(file.stats),
    "last-modified": file.stats.mtime.toUTCString()
  };
}

async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: StaticFile
): Promise<void> {
  const headers = fileHeaders(file);
  if (isNotModified(request, file)) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, {
    ...headers,
    "content-length": file.stats.size
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await pipeline(createReadStream(file.path), response);
}

function sendBadRequest(
  request: IncomingMessage,
  response: ServerResponse
): void {
  const body = JSON.stringify({ error: "bad_request" });
  response.writeHead(400, {
    ...SECURITY_HEADERS,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8"
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

export function createStaticWebHandler(
  options: StaticWebOptions
): StaticWebHandler {
  if (
    options.webRoot.length === 0 ||
    options.webRoot.includes("\0")
  ) {
    throw new TypeError("Invalid static web root.");
  }
  const root = realpathSync(resolve(options.webRoot));
  if (!statSync(root).isDirectory()) {
    throw new TypeError("Static web root must be a directory.");
  }
  const indexPath = resolve(root, "index.html");

  return async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    const segments = requestPath(request.url);
    if (segments === null) {
      sendBadRequest(request, response);
      return true;
    }
    const requestedPath = segments.length === 0
      ? indexPath
      : resolve(root, ...segments);
    let file = await regularFile(root, requestedPath);
    if (
      file === null &&
      segments.length > 0 &&
      acceptsSpaFallback(request, segments)
    ) {
      file = await regularFile(root, indexPath);
    }
    if (file === null) return false;
    await sendFile(request, response, file);
    return true;
  };
}
