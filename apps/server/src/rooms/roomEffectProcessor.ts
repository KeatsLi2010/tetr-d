import type { RoomEffect, RoomState } from "../../../../packages/room-core/src/model.ts";
import { PROTOCOL_VERSION } from "../../../../packages/protocol/src/versions.ts";
import type { SessionStore } from "../auth/sessionStore.ts";
import type { ConnectionHub } from "../gateway/connectionHub.ts";
import {
  MAX_PIECE_WINDOW,
  type MatchPieceSequence
} from "../matchPieceSequence.ts";
import { MatchRegistry } from "../matches/matchRegistry.ts";
import {
  RoomEffectActions,
  type RoomEffectProgress
} from "./roomEffectActions.ts";
import { RoomCommitOutbox } from "./roomCommitOutbox.ts";
import type {
  RoomCommitOutboxOptions,
  RoomEffectDelivery
} from "./roomCommitOutbox.ts";
import type { RoomRuntimeCommit } from "./roomRuntime.ts";

export interface RoomEffectProcessorOptions {
  readonly sessions: SessionStore;
  readonly connections: ConnectionHub;
  readonly getRoomState: (roomId: string) => RoomState | null;
  readonly removeRoom: (
    roomId: string,
    deliveryId: string
  ) => boolean | void | Promise<boolean | void>;
  readonly outbox?: Omit<RoomCommitOutboxOptions, "handler" | "onError">;
  readonly pieceWindowSize?: number;
  readonly matchTickRateHz?: number;
  readonly matches?: MatchRegistry;
  readonly onError?: (
    error: unknown,
    delivery: RoomEffectDelivery | null
  ) => void;
}

interface CommitContext {
  readonly before: RoomState;
  readonly after: RoomState;
  readonly effectCount: number;
}

function contextKey(roomId: string, revision: number): string {
  return JSON.stringify([roomId, revision]);
}

export class RoomEffectProcessor {
  readonly #onError: NonNullable<RoomEffectProcessorOptions["onError"]>;
  readonly #matches: MatchRegistry;
  readonly #ownsMatches: boolean;
  readonly #actions: RoomEffectActions;
  readonly #outbox: RoomCommitOutbox;
  readonly #contexts = new Map<string, CommitContext>();
  readonly #progress = new Map<string, RoomEffectProgress>();
  #disposed = false;

  constructor(options: RoomEffectProcessorOptions) {
    this.#onError = options.onError ?? (() => undefined);
    const pieceWindowSize = options.pieceWindowSize ?? MAX_PIECE_WINDOW;
    const matchTickRateHz = options.matchTickRateHz ?? 240;
    if (
      PROTOCOL_VERSION !== 3 ||
      !Number.isSafeInteger(pieceWindowSize) ||
      pieceWindowSize < 1 ||
      pieceWindowSize > MAX_PIECE_WINDOW ||
      !Number.isSafeInteger(matchTickRateHz) ||
      matchTickRateHz < 60 ||
      matchTickRateHz > 1_000
    ) {
      throw new TypeError("Invalid room effect processor options.");
    }
    this.#matches = options.matches ?? new MatchRegistry({
      sessions: options.sessions,
      connections: options.connections,
      tickRateHz: matchTickRateHz,
      getRoomState: options.getRoomState,
      onMatchFinished: () => undefined,
      onError: (error) => this.#report(error, null)
    });
    this.#ownsMatches = options.matches === undefined;
    this.#actions = new RoomEffectActions({
      sessions: options.sessions,
      connections: options.connections,
      getRoomState: options.getRoomState,
      removeRoom: options.removeRoom,
      matches: this.#matches,
      report: (error, delivery) => this.#report(error, delivery)
    });
    this.#outbox = new RoomCommitOutbox({
      ...options.outbox,
      handler: (delivery) => this.#handle(delivery),
      onError: (error, delivery) => this.#report(error, delivery)
    });
  }

  get pendingCount(): number {
    return this.#outbox.pendingCount;
  }

  get matchCount(): number {
    return this.#matches.matchCount;
  }

  enqueue(commit: RoomRuntimeCommit): boolean {
    if (this.#disposed) throw new Error("ROOM_EFFECT_PROCESSOR_DISPOSED");
    this.#matches.pruneRoom(
      commit.after.roomId,
      commit.after.activeMatch?.matchId ?? null
    );
    const revision = commit.after.presenceSequence;
    const key = contextKey(commit.after.roomId, revision);
    const existing = this.#contexts.get(key);
    const context: CommitContext = Object.freeze({
      before: commit.before,
      after: commit.after,
      effectCount: commit.effects.length
    });
    if (existing === undefined && commit.effects.length > 0) {
      this.#contexts.set(key, context);
    }
    try {
      const enqueued = this.#outbox.enqueue(commit);
      if (!enqueued && existing === undefined) this.#contexts.delete(key);
      return enqueued;
    } catch (error) {
      if (existing === undefined) this.#contexts.delete(key);
      throw error;
    }
  }

  async enqueueDurably(commit: RoomRuntimeCommit): Promise<boolean> {
    if (this.#disposed) throw new Error("ROOM_EFFECT_PROCESSOR_DISPOSED");
    this.#matches.pruneRoom(
      commit.after.roomId,
      commit.after.activeMatch?.matchId ?? null
    );
    const revision = commit.after.presenceSequence;
    const key = contextKey(commit.after.roomId, revision);
    const existing = this.#contexts.get(key);
    const context: CommitContext = Object.freeze({
      before: commit.before,
      after: commit.after,
      effectCount: commit.effects.length
    });
    if (existing === undefined && commit.effects.length > 0) {
      this.#contexts.set(key, context);
    }
    try {
      const enqueued = await this.#outbox.enqueueDurably(commit);
      if (!enqueued && existing === undefined) this.#contexts.delete(key);
      return enqueued;
    } catch (error) {
      if (existing === undefined) this.#contexts.delete(key);
      throw error;
    }
  }

  getMatchPieceSequence(matchId: string): MatchPieceSequence | null {
    return this.#matches.getMatchPieceSequence(matchId);
  }

  replayMatchStartForPlayer(playerId: string): boolean {
    if (this.#disposed) return false;
    return this.#actions.replayMatchStartForPlayer(playerId);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#outbox.dispose();
    this.#actions.dispose();
    if (this.#ownsMatches) this.#matches.dispose();
    this.#contexts.clear();
    this.#progress.clear();
  }

  async #handle(delivery: RoomEffectDelivery): Promise<void> {
    if (this.#disposed) return;
    const key = contextKey(delivery.roomId, delivery.revision);
    const context = this.#contexts.get(key);
    if (context === undefined) {
      throw new Error(`Missing room commit context: ${delivery.deliveryId}`);
    }
    const progress = this.#progressFor(delivery.deliveryId);
    await this.#handleEffect(delivery, context, progress);
    if (delivery.effectIndex === context.effectCount - 1) {
      this.#contexts.delete(key);
    }
    this.#progress.delete(delivery.deliveryId);
  }

  async #handleEffect(
    delivery: RoomEffectDelivery,
    context: CommitContext,
    progress: RoomEffectProgress
  ): Promise<void> {
    const effect = delivery.effect;
    switch (effect.type) {
      case "room.state_changed":
        this.#actions.sendRoomState(delivery.roomId);
        return;
      case "countdown.schedule":
        this.#actions.sendCountdown(context.after, effect, progress);
        return;
      case "countdown.cancel":
        return;
      case "match.start":
        this.#actions.startMatch(context.after, effect, progress);
        return;
      case "match.clear_input":
        this.#actions.clearMatchInput(context.after, effect);
        return;
      case "match.disconnect_forfeit":
        this.#actions.finishDisconnectedMatch(effect);
        return;
      case "member.reconnect_deadline":
        this.#actions.sendDisconnectedPresence(
          context.after,
          effect,
          progress
        );
        return;
      case "member.reconnect_expired":
        this.#actions.removeMember(
          delivery,
          context.before,
          effect.playerId,
          "reconnect_timeout",
          progress
        );
        return;
      case "member.kicked":
        this.#actions.removeMember(
          delivery,
          context.before,
          effect.playerId,
          "kicked",
          progress
        );
        return;
      case "room.closed":
        await this.#actions.closeRoom(
          delivery,
          context.before,
          effect.reason,
          progress
        );
        return;
    }
    const exhaustive: never = effect;
    throw new Error(`Unhandled room effect: ${String(exhaustive)}`);
  }

  #progressFor(deliveryId: string): RoomEffectProgress {
    let progress = this.#progress.get(deliveryId);
    if (progress === undefined) {
      progress = { completedActions: new Set<string>() };
      this.#progress.set(deliveryId, progress);
    }
    return progress;
  }

  #report(error: unknown, delivery: RoomEffectDelivery | null): void {
    try {
      this.#onError(error, delivery);
    } catch {
      // Best-effort reporting must not break critical effect retries.
    }
  }
}
