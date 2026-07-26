import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import test from "node:test";

import WebSocket from "ws";

import { createTetrServer } from "../src/serverApp.ts";
import type { TetrServerApp, TetrServerOptions } from "../src/serverApp.ts";

const ORIGIN = "http://gateway.test";
const HOST = "gateway.test";
const SUBPROTOCOL = "tetr-d.v3";

function secureOptions(
  overrides: Pick<
    TetrServerOptions,
    | "maxConnections"
    | "maxConnectionsPerIp"
    | "shutdownGraceMs"
    | "helloTimeoutMs"
  > = {}
): TetrServerOptions {
  return {
    allowedOrigins: [ORIGIN],
    allowedHosts: [HOST],
    sessionHmacKey: Buffer.alloc(32, 0x6b),
    ...overrides
  };
}

async function listen(app: TetrServerApp): Promise<{
  readonly port: number;
  readonly url: string;
}> {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    port: address.port,
    url: `ws://127.0.0.1:${address.port}/ws`
  };
}

function createClient(
  url: string,
  host = HOST,
  origin = ORIGIN
): WebSocket {
  return new WebSocket(url, SUBPROTOCOL, {
    origin,
    headers: { host }
  });
}

async function openClient(
  url: string,
  host = HOST,
  origin = ORIGIN
): Promise<WebSocket> {
  const socket = createClient(url, host, origin);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function expectRejected(
  url: string,
  expectedStatus: number,
  host = HOST,
  origin = ORIGIN
): Promise<void> {
  const socket = createClient(url, host, origin);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      socket.terminate();
      reject(new Error("WebSocket unexpectedly opened."));
    });
    socket.once("error", (error) => {
      if (error.message.includes(`Unexpected server response: ${expectedStatus}`)) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

async function openRawWebSocket(port: number): Promise<Socket> {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => undefined);
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(
    "GET /ws HTTP/1.1\r\n" +
      `Host: ${HOST}\r\n` +
      `Origin: ${ORIGIN}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
      `Sec-WebSocket-Protocol: ${SUBPROTOCOL}\r\n\r\n`
  );
  await new Promise<void>((resolve, reject) => {
    let response = "";
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for raw upgrade.")),
      2_000
    );
    socket.on("data", function onData(chunk: Buffer) {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.off("data", onData);
      try {
        assert.match(response, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  return socket;
}

test("allowlists fail closed and open development is loopback-only", async () => {
  assert.throws(
    () => createTetrServer({ allowedOrigins: [ORIGIN] }),
    /Origin and Host allowlists/
  );
  assert.throws(
    () =>
      createTetrServer({
        environment: "production",
        allowUnsafeDevelopmentAccess: true
      }),
    /forbidden in production/
  );
  assert.throws(
    () =>
      createTetrServer({
        environment: "production",
        allowedOrigins: [ORIGIN],
        allowedHosts: [HOST]
      }),
    /SESSION_HMAC_KEY is required/
  );

  const app = createTetrServer({
    allowUnsafeDevelopmentAccess: true,
    sessionHmacKey: Buffer.alloc(32, 0x31)
  });
  await assert.rejects(
    app.listen({ host: "0.0.0.0", port: 0 }),
    /loopback listener/
  );
  const { url } = await listen(app);
  const socket = await openClient(
    url,
    "unlisted.internal",
    "http://unlisted.internal"
  );
  socket.terminate();
  await app.close();
});

test("Host and Origin allowlists use exact values", async () => {
  const app = createTetrServer(secureOptions());
  const { url } = await listen(app);
  const accepted = await openClient(url);
  await expectRejected(url, 403, `${HOST}.evil`);
  await expectRejected(url, 403, HOST, `${ORIGIN}.evil`);
  await expectRejected(url, 403, HOST, `${ORIGIN}/path?next=evil`);
  assert.equal(app.gateway.connectionCount, 1);
  accepted.terminate();
  await app.close();
});

test("total and per-IP admission reject before WebSocket upgrade", async () => {
  const totalApp = createTetrServer(
    secureOptions({ maxConnections: 1, maxConnectionsPerIp: 1 })
  );
  const total = await listen(totalApp);
  const first = await openClient(total.url);
  await expectRejected(total.url, 503);
  assert.equal(totalApp.gateway.connectionCount, 1);
  first.terminate();
  await waitForClose(first);
  await totalApp.close();

  const ipApp = createTetrServer(
    secureOptions({ maxConnections: 2, maxConnectionsPerIp: 1 })
  );
  const perIp = await listen(ipApp);
  const second = await openClient(perIp.url);
  await expectRejected(perIp.url, 429);
  assert.equal(ipApp.gateway.connectionCount, 1);
  second.terminate();
  await ipApp.close();
});

test("server close terminates an uncooperative peer after grace", {
  timeout: 3_000
}, async () => {
  const app = createTetrServer(
    secureOptions({ shutdownGraceMs: 25, helloTimeoutMs: 2_000 })
  );
  const { port } = await listen(app);
  const raw = await openRawWebSocket(port);
  assert.equal(app.gateway.connectionCount, 1);
  const rawClosed = new Promise<void>((resolve) => {
    raw.once("close", () => resolve());
  });
  const firstClose = app.close();
  assert.strictEqual(firstClose, app.close());
  await firstClose;
  await rawClosed;
  assert.equal(raw.destroyed, true);
});
