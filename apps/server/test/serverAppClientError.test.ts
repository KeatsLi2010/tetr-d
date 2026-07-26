import assert from "node:assert/strict";
import { Socket } from "node:net";
import test from "node:test";
import type { TestContext } from "node:test";

import { createTetrServer } from "../src/serverApp.ts";
import type { TetrServerApp } from "../src/serverApp.ts";

function setup(t: TestContext, errors: unknown[]): TetrServerApp {
  const app = createTetrServer({
    allowedOrigins: ["http://integration.test"],
    allowedHosts: ["integration.test"],
    onError: (error) => errors.push(error)
  });
  t.after(() => app.close());
  return app;
}

test("clientError silently destroys ECONNRESET sockets", (t) => {
  const errors: unknown[] = [];
  const app = setup(t, errors);
  const socket = new Socket();
  const error = Object.assign(new Error("connection reset"), {
    code: "ECONNRESET"
  });

  app.server.emit("clientError", error, socket);

  assert.equal(socket.destroyed, true);
  assert.deepEqual(errors, []);
});

test("clientError reports other errors before destroying the socket", (t) => {
  const errors: unknown[] = [];
  const app = setup(t, errors);
  const socket = new Socket();
  const error = Object.assign(new Error("bad request"), {
    code: "EPROTO"
  });

  app.server.emit("clientError", error, socket);

  assert.equal(socket.destroyed, true);
  assert.deepEqual(errors, [error]);
});
