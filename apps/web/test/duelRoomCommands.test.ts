import assert from "node:assert/strict";
import test from "node:test";

import type { ClientMessage } from "@tetr-d/protocol";

import { DuelRoomCommands } from "../src/game/duel/DuelRoomCommands.ts";
import type { DuelRoomView } from "../src/game/duel/duelTypes.ts";

function viewAt(
  revision: number,
  phase: "lobby" | "series_complete" = "lobby"
): DuelRoomView {
  return {
    room: {
      roomId: "room-1",
      revision,
      phase
    },
    match: null
  } as unknown as DuelRoomView;
}

test("revision conflicts replay one ready intent against the new state", () => {
  let view = viewAt(7);
  const sent: ClientMessage[] = [];
  const commands = new DuelRoomCommands({
    getView: () => view,
    send: (message) => {
      sent.push(message);
      return true;
    }
  });

  commands.setReady(true);
  const first = sent[0];
  assert.equal(first?.type, "room.ready.set");
  if (first?.type !== "room.ready.set") return;
  assert.equal(first.expectedRevision, 7);

  view = viewAt(8);
  assert.equal(commands.handleError({
    type: "error",
    code: "REVISION_CONFLICT",
    message: "stale",
    retryable: true,
    requestId: first.requestId,
    currentRevision: 8
  }), true);

  const retry = sent[1];
  assert.equal(retry?.type, "room.ready.set");
  if (retry?.type !== "room.ready.set") return;
  assert.equal(retry.expectedRevision, 8);
  assert.notEqual(retry.requestId, first.requestId);

  commands.handleCommandOk({
    type: "room.command.ok",
    requestId: retry.requestId,
    roomId: "room-1",
    revision: 9,
    replayed: false
  });
  view = viewAt(9);
  commands.handleRoomState(9);
  commands.setReady(false);
  assert.equal(sent.length, 3);
});

test("series completion sends a rematch vote, not a ready mutation", () => {
  const sent: ClientMessage[] = [];
  const commands = new DuelRoomCommands({
    getView: () => viewAt(12, "series_complete"),
    send: (message) => {
      sent.push(message);
      return true;
    }
  });

  commands.nextRound();
  assert.equal(sent[0]?.type, "room.series.rematch");
});
