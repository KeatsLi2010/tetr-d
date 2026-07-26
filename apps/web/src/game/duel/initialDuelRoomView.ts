import type { DuelRoomView } from "./duelTypes.ts";

export const INITIAL_DUEL_ROOM_VIEW: DuelRoomView = Object.freeze({
  connection: "entry",
  player: null,
  room: null,
  match: null,
  players: Object.freeze([]),
  result: null,
  frameAnchor: null,
  error: null
});
