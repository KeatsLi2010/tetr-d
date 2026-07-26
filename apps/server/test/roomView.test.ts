import assert from "node:assert/strict";
import test from "node:test";

import {
  createRoom,
  transitionRoom
} from "../../../packages/room-core/src/room.ts";
import { projectRoomState } from "../src/rooms/roomView.ts";

test("room projection is viewer-specific and hides connection internals", () => {
  const initial = createRoom({
    roomId: "room-view",
    roomCode: "ABC234",
    creator: { playerId: "host", displayName: "Host" },
    connectionId: "connection-host",
    settings: { allowSpectators: true },
    nowMs: 1_000
  });
  const joined = transitionRoom(initial, {
    type: "member.join",
    requestId: "join-watcher",
    player: { playerId: "watcher", displayName: "Watcher" },
    connectionId: "connection-watcher",
    participation: "spectator",
    atMs: 1_100
  });
  assert.equal(joined.kind, "committed");
  if (joined.kind !== "committed") return;

  const host = projectRoomState(joined.state, "host");
  const watcher = projectRoomState(joined.state, "watcher");

  assert.equal(host.self.seat, 0);
  assert.equal(host.self.permissions.editSettings, true);
  assert.equal(watcher.self.participation, "spectator");
  assert.equal(watcher.self.permissions.editSettings, false);
  assert.equal(watcher.spectators[0]?.playerId, "watcher");
  assert.equal(JSON.stringify(host).includes("connection-host"), false);
  assert.equal(JSON.stringify(watcher).includes("joinedOrdinal"), false);
});

test("closed rooms cannot be projected as an active room state", () => {
  const state = createRoom({
    roomId: "room-closed-view",
    roomCode: "DEF567",
    creator: { playerId: "host", displayName: "Host" },
    connectionId: "connection-host",
    nowMs: 1_000
  });
  const closed = transitionRoom(state, {
    type: "room.close",
    requestId: "close",
    actorPlayerId: "host",
    expectedRevision: state.revision,
    atMs: 1_100
  });
  assert.equal(closed.kind, "committed");
  if (closed.kind !== "committed") return;
  assert.throws(() => projectRoomState(closed.state, "host"), /room.closed/);
});
