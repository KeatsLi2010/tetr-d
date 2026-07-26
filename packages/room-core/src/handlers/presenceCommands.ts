import type {
  RoomCommand,
  RoomConnection,
  RoomEffect,
  RoomPolicy,
  RoomState,
  RoomTransition
} from "../model.ts";
import {
  SAFE_ID,
  connected,
  ownMember,
  seatOf,
  setMember
} from "../validation.ts";
import {
  cancelCountdown,
  closeState,
  commit,
  ignore,
  reject,
  removeMemberState
} from "../operations.ts";

export function handlePresenceCommand(
  state: RoomState,
  command: RoomCommand,
  policy: RoomPolicy
): RoomTransition | null {
  switch (command.type) {
    case "connection.lost": {
      const member = ownMember(state.members, command.playerId);
      if (
        !member ||
        member.connection.kind !== "connected" ||
        member.connection.connectionId !== command.connectionId ||
        member.connection.epoch !== command.expectedConnectionEpoch
      ) {
        return ignore(state, "stale_connection");
      }
      const seat = seatOf(state, command.playerId);
      const reconnectDeadlineMs =
        command.atMs +
        (seat !== null && state.phase === "playing"
          ? policy.matchReconnectGraceMs
          : policy.lobbyReconnectGraceMs);
      const connection: RoomConnection = {
        kind: "disconnected",
        epoch: member.connection.epoch,
        reconnectDeadlineMs,
        forfeitRequested: false
      };
      let proposed: RoomState = {
        ...state,
        members: setMember(state.members, command.playerId, {
          ...member,
          connection
        })
      };
      let effects: readonly RoomEffect[] = [
        {
          type: "member.reconnect_deadline",
          playerId: command.playerId,
          deadlineMs: reconnectDeadlineMs
        }
      ];
      if (seat !== null && state.ready[seat]) {
        const ready: [boolean, boolean] = [
          seat === 0 ? false : state.ready[0],
          seat === 1 ? false : state.ready[1]
        ];
        proposed = { ...proposed, ready };
      }
      if (
        seat !== null &&
        state.phase === "series_complete" &&
        state.rematchVotes[seat]
      ) {
        const rematchVotes: [boolean, boolean] = [
          seat === 0 ? false : state.rematchVotes[0],
          seat === 1 ? false : state.rematchVotes[1]
        ];
        proposed = { ...proposed, rematchVotes };
      }
      if (state.phase === "countdown" && seat !== null) {
        const cancelled = cancelCountdown(proposed, "disconnect");
        proposed = cancelled.state;
        effects = [...effects, ...cancelled.effects];
      } else if (state.phase === "playing" && seat !== null) {
        effects = [
          ...effects,
          { type: "match.clear_input", playerId: command.playerId }
        ];
      }
      return commit(
        state,
        proposed,
        command.atMs,
        effects,
        policy,
        seat !== null
      );
    }

    case "connection.resumed": {
      const member = ownMember(state.members, command.playerId);
      if (
        !member ||
        member.connection.kind !== "disconnected" ||
        member.connection.epoch !== command.expectedConnectionEpoch
      ) {
        return ignore(state, "stale_connection");
      }
      if (
        command.atMs >= member.connection.reconnectDeadlineMs ||
        member.connection.forfeitRequested
      ) {
        return reject(state, "RESUME_EXPIRED");
      }
      if (!SAFE_ID.test(command.newConnectionId)) {
        return reject(state, "INVALID_COMMAND");
      }
      if (
        Object.values(state.members).some(
          (candidate) =>
            candidate.connection.kind === "connected" &&
            candidate.connection.connectionId === command.newConnectionId
        )
      ) {
        return reject(state, "INVALID_COMMAND");
      }
      const connection: RoomConnection = {
        kind: "connected",
        connectionId: command.newConnectionId,
        epoch: member.connection.epoch + 1
      };
      let proposed: RoomState = {
        ...state,
        members: setMember(state.members, command.playerId, {
          ...member,
          connection
        })
      };
      if (proposed.hostPlayerId === null) {
        proposed = { ...proposed, hostPlayerId: command.playerId };
      }
      return commit(
        state,
        proposed,
        command.atMs,
        [],
        policy,
        seatOf(state, command.playerId) !== null ||
          proposed.hostPlayerId !== state.hostPlayerId
      );
    }

    case "connection.replace": {
      const member = ownMember(state.members, command.playerId);
      if (
        !member ||
        member.connection.kind !== "connected" ||
        member.connection.connectionId !== command.expectedConnectionId ||
        member.connection.epoch !== command.expectedConnectionEpoch
      ) {
        return ignore(state, "stale_connection");
      }
      if (
        !SAFE_ID.test(command.newConnectionId) ||
        command.newConnectionId === command.expectedConnectionId ||
        Object.values(state.members).some(
          (candidate) =>
            candidate.connection.kind === "connected" &&
            candidate.connection.connectionId === command.newConnectionId
        )
      ) {
        return reject(state, "INVALID_COMMAND");
      }
      const proposed: RoomState = {
        ...state,
        members: setMember(state.members, command.playerId, {
          ...member,
          connection: {
            kind: "connected",
            connectionId: command.newConnectionId,
            epoch: member.connection.epoch + 1
          }
        })
      };
      const effects: readonly RoomEffect[] =
        state.phase === "playing" && seatOf(state, command.playerId) !== null
          ? [{ type: "match.clear_input", playerId: command.playerId }]
          : [];
      return commit(
        state,
        proposed,
        command.atMs,
        effects,
        policy,
        false
      );
    }

    case "timer.reconnect_elapsed": {
      const member = ownMember(state.members, command.playerId);
      if (
        !member ||
        member.connection.kind !== "disconnected" ||
        member.connection.epoch !== command.expectedConnectionEpoch
      ) {
        return ignore(state, "stale_connection");
      }
      if (command.atMs < member.connection.reconnectDeadlineMs) {
        return ignore(state, "stale_timer");
      }
      const seat = seatOf(state, command.playerId);
      if (
        seat !== null &&
        state.phase === "playing" &&
        state.activeMatch !== null
      ) {
        if (
          member.connection.forfeitRequested ||
          state.activeMatch.resolutionRequested
        ) {
          return ignore(state, "stale_timer");
        }
        const opponentId = state.seats[seat === 0 ? 1 : 0];
        const winnerPlayerId =
          opponentId !== null &&
          connected(ownMember(state.members, opponentId))
            ? opponentId
            : null;
        const connection: RoomConnection = {
          ...member.connection,
          forfeitRequested: true
        };
        const proposed: RoomState = {
          ...state,
          activeMatch: {
            ...state.activeMatch,
            resolutionRequested: true
          },
          members: setMember(state.members, command.playerId, {
            ...member,
            connection
          })
        };
        return commit(
          state,
          proposed,
          command.atMs,
          [
            {
              type: "match.disconnect_forfeit",
              matchId: state.activeMatch.matchId,
              loserPlayerId: command.playerId,
              winnerPlayerId
            }
          ],
          policy
        );
      }
      const removed = removeMemberState(state, command.playerId, false);
      return commit(
        state,
        removed.state,
        command.atMs,
        [
          ...removed.effects,
          { type: "member.reconnect_expired", playerId: command.playerId }
        ],
        policy
      );
    }
    case "timer.room_expired": {
      if (
        state.phase === "closed" ||
        command.atMs < state.expiresAtMs
      ) {
        return ignore(state, "stale_timer");
      }
      const proposed = closeState(state, "expired");
      return commit(
        state,
        proposed,
        command.atMs,
        [{ type: "room.closed", reason: "expired" }],
        policy
      );
    }

    case "admin.close": {
      if (state.phase === "closed") return ignore(state, "stale_timer");
      const proposed = closeState(state, command.reason);
      return commit(
        state,
        proposed,
        command.atMs,
        [{ type: "room.closed", reason: command.reason }],
        policy
      );
    }
  }
  return null;
}
