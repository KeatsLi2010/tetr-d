import type {
  RoomCommand,
  RoomEffect,
  RoomPolicy,
  RoomSeries,
  RoomState,
  RoomTransition
} from "../model.ts";
import {
  SAFE_ID,
  connected,
  ownMember,
  rosterOf,
  setMember
} from "../validation.ts";
import {
  cancelCountdown,
  commit,
  ignore,
  reject
} from "../operations.ts";

export function handleMatchCommand(
  state: RoomState,
  command: RoomCommand,
  policy: RoomPolicy
): RoomTransition | null {
  switch (command.type) {
    case "timer.countdown_elapsed": {
      if (
        state.phase !== "countdown" ||
        state.countdown === null ||
        state.countdown.countdownId !== command.countdownId
      ) {
        return ignore(state, "stale_timer");
      }
      if (command.atMs < state.countdown.startsAtMs) {
        return ignore(state, "stale_timer");
      }
      const roster = rosterOf(state);
      if (
        roster === null ||
        !state.ready[0] ||
        !state.ready[1] ||
        !connected(ownMember(state.members, roster[0])) ||
        !connected(ownMember(state.members, roster[1])) ||
        state.series === null
      ) {
        const cancelled = cancelCountdown(state, "roster_changed");
        return commit(
          state,
          cancelled.state,
          command.atMs,
          cancelled.effects,
          policy
        );
      }
      if (!SAFE_ID.test(command.matchId)) {
        return reject(state, "INVALID_COMMAND");
      }
      const gameNumber = state.countdown.gameNumber;
      const proposed: RoomState = {
        ...state,
        phase: "playing",
        ready: [false, false],
        countdown: null,
        activeMatch: {
          matchId: command.matchId,
          gameNumber,
          participants: roster,
          startedAtMs: command.atMs,
          resolutionRequested: false
        }
      };
      return commit(
        state,
        proposed,
        command.atMs,
        [
          {
            type: "match.start",
            matchId: command.matchId,
            seriesId: state.series.seriesId,
            gameNumber,
            participants: roster
          }
        ],
        policy
      );
    }

    case "match.finished": {
      if (
        state.phase !== "playing" ||
        state.activeMatch === null ||
        state.activeMatch.matchId !== command.matchId ||
        state.series === null
      ) {
        return ignore(state, "stale_match");
      }
      if (
        !Number.isSafeInteger(command.serverFrame) ||
        command.serverFrame < 0 ||
        ![
          "topout",
          "forfeit",
          "disconnect_timeout",
          "simultaneous_topout",
          "draw"
        ].includes(command.reason) ||
        ((command.reason === "draw" ||
          command.reason === "simultaneous_topout") &&
          command.winnerPlayerId !== null) ||
        ((command.reason === "topout" || command.reason === "forfeit") &&
          command.winnerPlayerId === null) ||
        (command.winnerPlayerId !== null &&
          !state.activeMatch.participants.includes(command.winnerPlayerId))
      ) {
        return reject(state, "INVALID_COMMAND");
      }
      const wins: [number, number] = [
        state.series.wins[0],
        state.series.wins[1]
      ];
      if (command.winnerPlayerId !== null) {
        const winnerSeat =
          state.series.roster[0] === command.winnerPlayerId ? 0 : 1;
        wins[winnerSeat] += 1;
      }
      const completed =
        wins[0] >= state.series.targetWins ||
        wins[1] >= state.series.targetWins;
      const winnerPlayerId = completed
        ? wins[0] >= state.series.targetWins
          ? state.series.roster[0]
          : state.series.roster[1]
        : null;
      const series: RoomSeries = {
        ...state.series,
        wins,
        gamesPlayed: state.series.gamesPlayed + 1,
        completed,
        winnerPlayerId
      };
      let members = state.members;
      const effects: RoomEffect[] = [];
      for (const playerId of state.activeMatch.participants) {
        const member = ownMember(members, playerId);
        if (member?.connection.kind !== "disconnected") continue;
        const reconnectDeadlineMs =
          command.atMs + policy.lobbyReconnectGraceMs;
        members = setMember(members, playerId, {
          ...member,
          connection: {
            ...member.connection,
            reconnectDeadlineMs,
            forfeitRequested: false
          }
        });
        effects.push({
          type: "member.reconnect_deadline",
          playerId,
          deadlineMs: reconnectDeadlineMs
        });
      }
      const proposed: RoomState = {
        ...state,
        members,
        phase: completed ? "series_complete" : "between_games",
        ready: [false, false],
        rematchVotes: [false, false],
        rulesStatus: completed ? "draft" : "locked",
        countdown: null,
        series,
        activeMatch: null
      };
      return commit(state, proposed, command.atMs, effects, policy);
    }
  }
  return null;
}
