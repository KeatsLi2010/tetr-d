import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTetrServer,
  type TetrServerApp
} from "../src/serverApp.ts";

interface RunningServer {
  readonly app: TetrServerApp;
  readonly port: number;
}

interface HttpResult {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: string;
}

async function startServer(webRoot?: string): Promise<RunningServer> {
  const app = createTetrServer({
    allowedOrigins: ["http://integration.test"],
    allowedHosts: ["integration.test"],
    ...(webRoot === undefined ? {} : { webRoot })
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, port: address.port };
}

function get(port: number, path: string): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers: { connection: "close" }
    });
    outgoing.once("error", reject);
    outgoing.once("response", (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => {
        resolve({
          status: incoming.statusCode ?? 0,
          contentType: incoming.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    outgoing.end();
  });
}

test("server keeps JSON not-found behavior without a web root", async () => {
  const fixture = await startServer();
  try {
    const response = await get(fixture.port, "/");
    assert.equal(response.status, 404);
    assert.equal(
      response.contentType,
      "application/json; charset=utf-8"
    );
    assert.deepEqual(JSON.parse(response.body), { error: "not_found" });
  } finally {
    await fixture.app.close();
  }
});

test("server serves the SPA while preserving API routing", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tetr-d-app-static-"));
  const webRoot = join(temporaryRoot, "dist");
  const indexBody = "<!doctype html><title>TETR-D</title><main>duel</main>";
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, "index.html"), indexBody, "utf8");
  const fixture = await startServer(webRoot);

  try {
    const home = await get(fixture.port, "/");
    assert.equal(home.status, 200);
    assert.equal(home.contentType, "text/html; charset=utf-8");
    assert.equal(home.body, indexBody);

    const health = await get(fixture.port, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(
      health.contentType,
      "application/json; charset=utf-8"
    );
    const healthBody = JSON.parse(health.body) as {
      readonly ok: boolean;
      readonly service: string;
    };
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.service, "tetr-d-server");

    const missingApi = await get(fixture.port, "/api/missing");
    assert.equal(missingApi.status, 404);
    assert.equal(
      missingApi.contentType,
      "application/json; charset=utf-8"
    );
    assert.deepEqual(
      JSON.parse(missingApi.body),
      { error: "not_found" }
    );
  } finally {
    await fixture.app.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
