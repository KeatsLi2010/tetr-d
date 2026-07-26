import type {
  RoomCommand,
  RoomEffect,
  RoomMember,
  RoomPolicy,
  RoomState,
  RoomTransition
} from "../model.ts";
import {
  SAFE_ID,
  connected,
  hasOwn,
  isTargetWins,
  isValidPlayer,
  ownMember,
  rosterOf,
  seatOf,
  setMember,
  spectatorCount
} from "../validation.ts";
import {
  actorError,
  beginCountdown,
  cancelCountdown,
  closeState,
  commit,
  countdownCancelEffect,
  hostError,
  reject,
  removeMemberState,
  resetCompetition,
  versionError
} from "../operations.ts";

export function handleRoomCommand(
  state: RoomState,
  command: RoomCommand,
  policy: RoomPolicy
): RoomTransition | null {
  switch (command.type) {
    case "member.join": {
      if (state.phase === "closed") return reject(state, "ROOM_CLOSED");
      if (
        !isValidPlayer(command.player) ||
        !SAFE_ID.test(command.connectionId)
      ) {
        return reject(state, "INVALID_COMMAND");
      }
      const playerId = command.player.playerId;
      if (state.deniedPlayerIds.includes(playerId)) {
        return reject(state, "ROOM_KICKED");
      }
      if (hasOwn(state.members, playerId)) {
        return reject(state, "ALREADY_IN_ROOM");
      }
      const member: RoomMember = {
        player: command.player,
        joinedOrdinal: state.nextJoinedOrdinal,
        connection: {
          kind: "connected",
          connectionId: command.connectionId,
          epoch: 0
        }
      };
      let proposed: RoomState = {
        ...state,
        members: setMember(state.members, playerId, member),
        nextJoinedOrdinal: state.nextJoinedOrdinal + 1
      };
      let effects: readonly RoomEffect[] = [];
      if (command.participation === "spectator") {
        if (!state.settings.allowSpectators) {
          return reject(state, "SPECTATING_DISABLED");
        }
        if (spectatorCount(state) >= policy.maxSpectators) {
          return reject(state, "SPECTATOR_LIMIT");
        }
      } else {
        if (state.phase !== "lobby" && state.phase !== "series_complete") {
          return reject(state, "INVALID_ROOM_PHASE");
        }
        let targetSeat = command.preferredSeat;
        if (targetSeat !== undefined && state.seats[targetSeat] !== null) {
          return reject(state, "SEAT_OCCUPIED");
        }
        targetSeat ??= state.seats[0] === null ? 0 : 1;
        if (state.seats[targetSeat] !== null) {
          return reject(state, "ROOM_FULL");
        }
        const seats: [string | null, string | null] = [
          targetSeat === 0 ? playerId : state.seats[0],
          targetSeat === 1 ? playerId : state.seats[1]
        ];
        effects = countdownCancelEffect(state, "roster_changed");
        proposed = resetCompetition({ ...proposed, seats });
      }
      if (proposed.hostPlayerId === null) {
        proposed = { ...proposed, hostPlayerId: playerId };
      }
      return commit(state, proposed, command.atMs, effects, policy);
    }

    case "member.leave": {
      const version = versionError(state, command.expectedRevision);
      if (version) return version;
      const error = actorError(state, command.actorPlayerId);
      if (error) return error;
      if (
        seatOf(state, command.actorPlayerId) !== null &&
        state.phase === "playing"
      ) {
        return reject(state, "ACTIVE_MATCH");
      }
      const removed = removeMemberState(
        state,
        command.actorPlayerId,
        false
      );
      return commit(state, removed.state, command.atMs, removed.effects, policy);
    }

    case "seat.set": {
      const version = versionError(state, command.expectedRevision);
      if (version) return version;
      const error = actorError(state, command.actorPlayerId);
      if (error) return error;
      if (state.phase !== "lobby" && state.phase !== "series_complete") {
        return reject(state, "INVALID_ROOM_PHASE");
      }
      const currentSeat = seatOf(state, command.actorPlayerId);
      if (currentSeat === command.seat) return reject(state, "NO_CHANGE");
      if (command.seat === null) {
        if (currentSeat === null) return reject(state, "NO_CHANGE");
        if (!state.settings.allowSpectators) {
          return reject(state, "SPECTATING_DISABLED");
        }
        if (spectatorCount(state) >= policy.maxSpectators) {
          return reject(state, "SPECTATOR_LIMIT");
        }
      } else if (state.seats[command.seat] !== null) {
        return reject(state, "SEAT_OCCUPIED");
      }
      const seats: [string | null, string | null] = [
        currentSeat === 0 ? null : state.seats[0],
        currentSeat === 1 ? null : state.seats[1]
      ];
      if (command.seat !== null) seats[command.seat] = command.actorPlayerId;
      const effects = countdownCancelEffect(state, "roster_changed");
      const proposed = resetCompetition({ ...state, seats });
      return commit(state, proposed, command.atMs, effects, policy);
    }

    case "ready.set": {
      const version = versionError(state, command.expectedRevision);
      if (version) return version;
      const error = actorError(state, command.actorPlayerId);
      if (error) return error;
      const seat = seatOf(state, command.actorPlayerId);
      if (seat === null) return reject(state, "NOT_SEATED");
      if (
        state.phase !== "lobby" &&
        state.phase !== "between_games" &&
        state.phase !== "countdown"
      ) {
        return reject(state, "INVALID_ROOM_PHASE");
      }
      if (state.phase === "countdown") {
        if (command.ready) return reject(state, "NO_CHANGE");
        const cancelled = cancelCountdown(state, "unready");
        return commit(
          state,
          cancelled.state,
          command.atMs,
          cancelled.effects,
          policy
        );
      }
      if (state.ready[seat] === command.ready) {
        return reject(state, "NO_CHANGE");
      }
      const ready: [boolean, boolean] = [
        seat === 0 ? command.ready : state.ready[0],
        seat === 1 ? command.ready : state.ready[1]
      ];
      let proposed: RoomState = { ...state, ready };
      let effects: readonly RoomEffect[] = [];
      const roster = rosterOf(proposed);
      if (
        ready[0] &&
        ready[1] &&
        roster !== null &&
        connected(ownMember(proposed.members, roster[0])) &&
        connected(ownMember(proposed.members, roster[1]))
      ) {
        const started = beginCountdown(
          proposed,
          command.atMs,
          state.phase,
          policy
        );
        proposed = started.state;
        effects = started.effects;
      }
      return commit(state, proposed, command.atMs, effects, policy);
    }

    case "settings.update": {
      const version = versionError(state, command.expectedRevision);
      if (version) return version;
      const error = hostError(state, command.actorPlayerId);
      if (error) return error;
      if (state.phase !== "lobby" && state.phase !== "series_complete") {
        return reject(state, "RULES_LOCKED");
      }
      const keys = Object.keys(command.patch);
      if (
        keys.some(
          (key) => key !== "targetWins" && key !== "allowSpectators"
        ) ||
        (command.patch.targetWins !== undefined &&
          !isTargetWins(command.patch.targetWins)) ||
        (command.patch.allowSpectators !== undefined &&
          typeof command.patch.allowSpectators !== "boolean")
      ) {
        return reject(state, "RULES_INVALID");
      }
      const settings = {
        targetWins: command.patch.targetWins ?? state.settings.targetWins,
        allowSpectators:
          command.patch.allowSpectators ?? state.settings.allowSpectators
      };
      if (!settings.allowSpectators && spectatorCount(state) > 0) {
        return reject(state, "RULES_INVALID");
      }
      if (
        settings.targetWins === state.settings.targetWins &&
        settings.allowSpectators === state.settings.allowSpectators
      ) {
        return reject(state, "NO_CHANGE");
      }
      const proposed = resetCompetition({ ...state, settings });
      return commit(state, proposed, command.atMs, [], policy);
    }

    case "host.transfer": {
      const version = versionError(state, command.expectedRevision);
      if (version) return version;
      const error = hostError(state, command.actorPlayerId);
      if (error) return error;
      if (state.phase !== "lobby" && state.phase !== "series_complete") {
        return reject(state, "INVALID_ROOM_PHASE");
      }
      const target = ownMember(state.members, command.targetPlayerId);
      if (!target) return reject(state, "TARGET_NOT_MEMBER");
      if (!connected(target)) return reject(state, "TARGET_NOT_CONNECTED");
      if (command.targetPlayerId === state.hostPlayerId) {
        return reject(state, "NO_CHANGE");
      }
      return commit(
        state,
        { ...state, hostPlayerId: command.targetPlayerId },
        command.atMs,
        [],
        policy
      );
    }

    case "member.kick": {
      const version = versionError(state, command.expectedRevision);
      if (version) return version;
      const error = hostError(state, command.actorPlayerId);
      if (error) return error;
      if (command.targetPlayerId === command.actorPlayerId) {
        return reject(state, "CANNOT_KICK_SELF");
      }
      if (!ownMember(state.members, command.targetPlayerId)) {
        return reject(state, "TARGET_NOT_MEMBER");
      }
      if (
        seatOf(state, command.targetPlayerId) !== null &&
        (state.rulesStatus === "locked" ||
          state.phase === "countdown" ||
          state.phase === "playing" ||
          state.phase === "between_games")
      ) {
        return reject(state, "CANNOT_KICK_ACTIVE_PLAYER");
      }
      const removed = removeMemberState(
        state,
        command.targetPlayerId,
        true
      );
      return commit(
        state,
        removed.state,
        command.atMs,
        [
          ...removed.effects,
          { type: "member.kicked", playerId: command.targetPlayerId }
        ],
        policy
      );
    }

    case "series.rematch": {
      const version = versionError(state, command.expectedRevision);
      if (version) return version;
      const error = actorError(state, command.actorPlayerId);
      if (error) return error;
      const seat = seatOf(state, command.actorPlayerId);
      if (seat === null) return reject(state, "NOT_SEATED");
      if (
        state.phase !== "series_complete" ||
        state.series === null ||
        !state.series.completed
      ) {
        return reject(state, "SERIES_NOT_COMPLETE");
      }
      if (state.rematchVotes[seat] === command.accepted) {
        return reject(state, "NO_CHANGE");
      }
      const rematchVotes: [boolean, boolean] = [
        seat === 0 ? command.accepted : state.rematchVotes[0],
        seat === 1 ? command.accepted : state.rematchVotes[1]
      ];
      let proposed: RoomState = { ...state, rematchVotes };
      let effects: readonly RoomEffect[] = [];
      if (
        rematchVotes[0] &&
        rematchVotes[1] &&
        state.seats[0] !== null &&
        state.seats[1] !== null &&
        connected(ownMember(state.members, state.seats[0])) &&
        connected(ownMember(state.members, state.seats[1]))
      ) {
        const started = beginCountdown(
          { ...proposed, ready: [true, true] },
          command.atMs,
          "series_complete",
          policy
        );
        proposed = started.state;
        effects = started.effects;
      }
      return commit(state, proposed, command.atMs, effects, policy);
    }

    case "room.close": {
      const version = versionError(state, command.expectedRevision);
      if (version) return version;
      const error = hostError(state, command.actorPlayerId);
      if (error) return error;
      if (state.phase !== "lobby" && state.phase !== "series_complete") {
        return reject(state, "ACTIVE_MATCH");
      }
      const proposed = closeState(state, "host_closed");
      return commit(
        state,
        proposed,
        command.atMs,
        [{ type: "room.closed", reason: "host_closed" }],
        policy
      );
    }
  }
  return null;
}
