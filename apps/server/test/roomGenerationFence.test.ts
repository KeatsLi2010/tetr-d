import assert from "node:assert/strict";
import test from "node:test";

import { SessionStore } from "../src/auth/sessionStore.ts";
import type { RoomActorPrincipal } from "../src/roomActor.ts";
import { RoomManager } from "../src/rooms/roomManager.ts";
import type { RoomRuntimeCommit } from "../src/rooms/roomRuntime.ts";

async function required<T>(value: Promise<T> | null): Promise<T> {
  if (value === null) throw new Error("Expected a managed room result.");
  return value;
}

test("queued old-generation command is fenced after resume rotation", async () => {
  const sessions = new SessionStore({
    hmacKey: Buffer.alloc(32, 0x74),
    now: () => 1_000
  });
  const issued = sessions.createGuest({
    displayName: "Host",
    connectionId: "connection-old"
  });
  const oldPrincipal: RoomActorPrincipal = {
    sessionId: issued.session.sessionId,
    connectionId: "connection-old",
    connectionGeneration: issued.session.connectionGeneration,
    player: {
      playerId: issued.session.playerId,
      displayName: issued.session.displayName
    }
  };
  const commits: RoomRuntimeCommit[] = [];
  const manager = new RoomManager({
    now: () => 1_000,
    isPrincipalCurrent: (principal) =>
      sessions.isCurrentConnection(
        principal.sessionId,
        principal.connectionId,
        principal.connectionGeneration
      ),
    registryOptions: {
      roomIdFactory: () => "room-generation-fence",
      codeFactory: () => "GEN234"
    },
    onCommit: (_roomId, commit) => {
      commits.push(commit);
    }
  });
  try {
    const room = manager.create({ principal: oldPrincipal });
    const queued = required(manager.dispatchUser(room.roomId, oldPrincipal, {
      type: "settings.update",
      requestId: "queued-settings",
      expectedRevision: room.state.revision,
      patch: { targetWins: 5 }
    }));

    const resumed = sessions.resume({
      resumeToken: issued.resumeToken,
      newConnectionId: "connection-new"
    });
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;

    const stale = await queued;
    assert.equal(stale.receipt.kind, "ignored");
    assert.equal(stale.replayed, false);
    assert.deepEqual(stale.effects, []);
    assert.equal(manager.getById(room.roomId)?.state.revision, 1);
    assert.equal(commits.length, 0);

    const currentPrincipal: RoomActorPrincipal = {
      sessionId: resumed.session.sessionId,
      connectionId: "connection-new",
      connectionGeneration: resumed.session.connectionGeneration,
      player: oldPrincipal.player
    };
    const fresh = await required(manager.dispatchUser(
      room.roomId,
      currentPrincipal,
      {
        type: "settings.update",
        requestId: "queued-settings",
        expectedRevision: room.state.revision,
        patch: { targetWins: 5 }
      }
    ));
    assert.equal(fresh.receipt.kind, "committed");
    assert.equal(fresh.replayed, false);
    assert.ok(fresh.effects.length > 0);
    assert.equal(manager.getById(room.roomId)?.state.settings.targetWins, 5);
    assert.equal(commits.length, 1);
  } finally {
    manager.dispose();
  }
});
