import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import {
  createStaticWebHandler,
  type StaticWebHandler
} from "../src/staticWeb.ts";

interface HttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

interface StaticFixture {
  readonly port: number;
  readonly indexBody: string;
  readonly hashedScriptBody: string;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function notFound(response: Parameters<StaticWebHandler>[1]): void {
  response.writeHead(404, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify({ error: "not_found" }));
}

async function setup(t: TestContext): Promise<StaticFixture> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tetr-d-static-"));
  const webRoot = join(temporaryRoot, "web");
  const assets = join(webRoot, "assets");
  const indexBody = "<!doctype html><title>TETR-D</title><main>app</main>";
  const hashedScriptBody = "globalThis.__tetrD = true;\n";
  await mkdir(assets, { recursive: true });
  await writeFile(join(webRoot, "index.html"), indexBody, "utf8");
  await writeFile(join(webRoot, "styles.css"), "body { color: white; }\n", "utf8");
  await writeFile(
    join(assets, "app-12345678.js"),
    hashedScriptBody,
    "utf8"
  );
  await writeFile(join(temporaryRoot, "secret.txt"), "do not serve", "utf8");

  const handler = createStaticWebHandler({ webRoot });
  const server = createServer((incoming, outgoing) => {
    void handler(incoming, outgoing)
      .then((handled) => {
        if (!handled && !outgoing.writableEnded) notFound(outgoing);
      })
      .catch(() => {
        if (outgoing.headersSent) {
          outgoing.destroy();
          return;
        }
        outgoing.writeHead(500);
        outgoing.end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  t.after(async () => {
    await closeServer(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  return {
    port: address.port,
    indexBody,
    hashedScriptBody
  };
}

function get(
  fixture: StaticFixture,
  path: string,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {}
): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port: fixture.port,
      path,
      method: options.method ?? "GET",
      headers: { connection: "close", ...options.headers }
    });
    outgoing.once("error", reject);
    outgoing.once("response", (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => {
        resolve({
          status: incoming.statusCode ?? 0,
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    outgoing.end();
  });
}

test("serves the SPA entry point with defensive headers", async (t) => {
  const fixture = await setup(t);
  const response = await get(fixture, "/?from=test");

  assert.equal(response.status, 200);
  assert.equal(response.body, fixture.indexBody);
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-cache");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.match(
    String(response.headers["content-security-policy"]),
    /default-src 'self'.*object-src 'none'.*connect-src 'self'/u
  );
});

test("HEAD and conditional requests preserve immutable asset metadata", async (t) => {
  const fixture = await setup(t);
  const path = "/assets/app-12345678.js";
  const head = await get(fixture, path, { method: "HEAD" });

  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(
    Number(head.headers["content-length"]),
    Buffer.byteLength(fixture.hashedScriptBody)
  );
  assert.equal(
    head.headers["cache-control"],
    "public, max-age=31536000, immutable"
  );
  assert.equal(
    head.headers["content-type"],
    "text/javascript; charset=utf-8"
  );
  assert.equal(typeof head.headers.etag, "string");

  const unchanged = await get(fixture, path, {
    headers: { "if-none-match": String(head.headers.etag) }
  });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body, "");
});

test("SPA fallback excludes API, websocket and missing asset paths", async (t) => {
  const fixture = await setup(t);
  const navigation = await get(fixture, "/rooms/duel", {
    headers: { accept: "text/html" }
  });
  assert.equal(navigation.status, 200);
  assert.equal(navigation.body, fixture.indexBody);

  for (const path of ["/api/missing", "/ws", "/assets/missing.js"]) {
    const response = await get(fixture, path, {
      headers: { accept: "text/html" }
    });
    assert.equal(response.status, 404, path);
    assert.equal(response.body, JSON.stringify({ error: "not_found" }));
  }

  const post = await get(fixture, "/", { method: "POST" });
  assert.equal(post.status, 404);
});

test("rejects encoded traversal, backslashes and malformed escapes", async (t) => {
  const fixture = await setup(t);
  for (const path of [
    "/%2e%2e%2fsecret.txt",
    "/%2e%2e%5csecret.txt",
    "/%ZZ"
  ]) {
    const response = await get(fixture, path);
    assert.equal(response.status, 400, path);
    assert.doesNotMatch(response.body, /do not serve/u);
  }
});

test("uses bounded caching for non-fingerprinted assets", async (t) => {
  const fixture = await setup(t);
  const response = await get(fixture, "/styles.css");

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/css; charset=utf-8");
  assert.equal(response.headers["cache-control"], "public, max-age=3600");
});
