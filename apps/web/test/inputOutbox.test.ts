import assert from "node:assert/strict";
import test from "node:test";

import type {
  InputAction
} from "../../../packages/protocol/src/matchMessages.ts";
import { InputOutbox } from "../src/realtime/InputOutbox.ts";

test("outbox pipelines messages without waiting for acknowledgements", () => {
  const sent: unknown[] = [];
  const outbox = new InputOutbox({
    matchId: "match-1",
    inputEpoch: 3,
    send: (message) => sent.push(message)
  });
  const action: InputAction = { kind: "moveStep", direction: "left" };
  outbox.enqueue(10, [action]);
  outbox.enqueue(10, [action]);
  outbox.enqueue(11, [action]);

  assert.equal(sent.length, 3);
  assert.deepEqual(outbox.pending.map(({ sequence }) => sequence), [0, 1, 2]);
  outbox.acknowledge(1);
  assert.deepEqual(outbox.pending.map(({ sequence }) => sequence), [2]);
});

test("outbox splits a local frame into stable 16-action messages", () => {
  const sent: { readonly sequence: number; readonly size: number }[] = [];
  const outbox = new InputOutbox({
    matchId: "match-2",
    inputEpoch: 0,
    send: (message) => sent.push({
      sequence: message.sequence,
      size: message.actions.length
    })
  });
  const actions: InputAction[] = Array.from(
    { length: 33 },
    () => ({ kind: "rotate", direction: "cw" })
  );
  outbox.enqueue(42, actions);

  assert.deepEqual(sent, [
    { sequence: 0, size: 16 },
    { sequence: 1, size: 16 },
    { sequence: 2, size: 1 }
  ]);
});
