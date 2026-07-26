import {
  access,
  mkdir,
  open,
  rename
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import {
  createReplayRecord,
  serializeReplayRecord
} from "./replayHashChain.ts";
import { resolveReplayPaths } from "./replayPaths.ts";
import {
  assertReplayPayload
} from "./replayTypes.ts";
import type {
  ReplayEndPayload,
  ReplayFramePayload,
  ReplayHeaderPayload,
  ReplayPayload
} from "./replayTypes.ts";

const DEFAULT_MAX_PENDING_RECORDS = 1_024;

export interface ReplayWriterCreateOptions {
  readonly rootDirectory: string;
  readonly header: ReplayHeaderPayload;
  readonly maxPendingRecords?: number;
}

export class ReplayBackpressureError extends Error {
  readonly code = "REPLAY_BACKPRESSURE";
  readonly pendingCount: number;
  readonly maxPendingRecords: number;

  constructor(pendingCount: number, maxPendingRecords: number) {
    super(
      `Replay writer has ${pendingCount}/${maxPendingRecords} pending records.`
    );
    this.pendingCount = pendingCount;
    this.maxPendingRecords = maxPendingRecords;
    this.name = "ReplayBackpressureError";
  }
}

export class ReplayWriter {
  readonly partialPath: string;
  readonly finalPath: string;
  readonly maxPendingRecords: number;

  #handle: FileHandle;
  #phase: "open" | "finalizing" | "closing" | "closed" | "failed" = "open";
  #tail: Promise<void> = Promise.resolve();
  #writeFailure: Error | undefined;
  #pendingCount = 0;
  #nextOrdinal = 0;
  #previousHash: string | null = null;
  #writeOffset = 0;
  #finalizePromise: Promise<string> | undefined;
  #closePartialPromise: Promise<void> | undefined;

  private constructor(
    handle: FileHandle,
    partialPath: string,
    finalPath: string,
    maxPendingRecords: number
  ) {
    this.#handle = handle;
    this.partialPath = partialPath;
    this.finalPath = finalPath;
    this.maxPendingRecords = maxPendingRecords;
  }

  static async create(
    options: ReplayWriterCreateOptions
  ): Promise<ReplayWriter> {
    assertReplayPayload(options.header);
    if (options.header.kind !== "header") {
      throw new TypeError("Replay writer requires a header payload.");
    }
    const maxPendingRecords = options.maxPendingRecords
      ?? DEFAULT_MAX_PENDING_RECORDS;
    if (
      !Number.isSafeInteger(maxPendingRecords)
      || maxPendingRecords < 1
    ) {
      throw new RangeError("maxPendingRecords must be a positive integer.");
    }
    const paths = resolveReplayPaths(
      options.rootDirectory,
      options.header.matchId
    );
    await mkdir(paths.rootDirectory, { recursive: true });
    try {
      await access(paths.finalPath);
      throw new Error(`Final replay already exists: ${paths.finalPath}`);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    const handle = await open(paths.partialPath, "wx");
    const writer = new ReplayWriter(
      handle,
      paths.partialPath,
      paths.finalPath,
      maxPendingRecords
    );
    try {
      await writer.#enqueueRecord(options.header, true);
      return writer;
    } catch (error) {
      writer.#phase = "failed";
      await closeQuietly(handle);
      throw error;
    }
  }

  get pendingCount(): number {
    return this.#pendingCount;
  }

  appendFrame(payload: ReplayFramePayload): Promise<void> {
    assertReplayPayload(payload);
    if (payload.kind !== "frame") {
      throw new TypeError("appendFrame requires a frame payload.");
    }
    this.#assertOpen();
    if (this.#pendingCount >= this.maxPendingRecords) {
      throw new ReplayBackpressureError(
        this.#pendingCount,
        this.maxPendingRecords
      );
    }
    return this.#enqueueRecord(payload, false);
  }

  finalize(payload: ReplayEndPayload): Promise<string> {
    if (this.#finalizePromise !== undefined) {
      return this.#finalizePromise;
    }
    assertReplayPayload(payload);
    if (payload.kind !== "end") {
      throw new TypeError("finalize requires an end payload.");
    }
    this.#assertOpen();
    this.#phase = "finalizing";
    this.#finalizePromise = this.#finish(payload);
    return this.#finalizePromise;
  }

  closePartial(): Promise<void> {
    if (this.#closePartialPromise !== undefined) {
      return this.#closePartialPromise;
    }
    if (this.#finalizePromise !== undefined) {
      return this.#finalizePromise.then(() => undefined);
    }
    if (this.#phase === "closed") return Promise.resolve();
    this.#assertOpen();
    this.#phase = "closing";
    this.#closePartialPromise = this.#finishPartial();
    return this.#closePartialPromise;
  }

  async #finish(payload: ReplayEndPayload): Promise<string> {
    try {
      await this.#enqueueRecord(payload, true);
      await this.#tail;
      if (this.#writeFailure !== undefined) throw this.#writeFailure;
      await this.#handle.sync();
      await this.#handle.close();
      await rename(this.partialPath, this.finalPath);
      this.#phase = "closed";
      return this.finalPath;
    } catch (error) {
      this.#phase = "failed";
      await closeQuietly(this.#handle);
      throw error;
    }
  }

  async #finishPartial(): Promise<void> {
    try {
      await this.#tail;
      if (this.#writeFailure !== undefined) throw this.#writeFailure;
      await this.#handle.sync();
      await this.#handle.close();
      this.#phase = "closed";
    } catch (error) {
      this.#phase = "failed";
      await closeQuietly(this.#handle);
      throw error;
    }
  }

  #enqueueRecord(
    payload: ReplayPayload,
    ignoreCapacity: boolean
  ): Promise<void> {
    if (
      !ignoreCapacity
      && this.#pendingCount >= this.maxPendingRecords
    ) {
      throw new ReplayBackpressureError(
        this.#pendingCount,
        this.maxPendingRecords
      );
    }
    const record = createReplayRecord(
      this.#nextOrdinal,
      this.#previousHash,
      payload
    );
    const bytes = Buffer.from(serializeReplayRecord(record), "utf8");
    this.#nextOrdinal += 1;
    this.#previousHash = record.hash;
    this.#pendingCount += 1;

    const write = this.#tail.then(async () => {
      if (this.#writeFailure !== undefined) throw this.#writeFailure;
      try {
        await this.#writeAll(bytes);
      } catch (error) {
        this.#writeFailure = toError(error);
        throw this.#writeFailure;
      }
    });
    this.#tail = write.then(
      () => undefined,
      () => undefined
    );
    return write.then(
      () => {
        this.#pendingCount -= 1;
      },
      (error: unknown) => {
        this.#pendingCount -= 1;
        throw error;
      }
    );
  }

  async #writeAll(bytes: Buffer): Promise<void> {
    let bufferOffset = 0;
    while (bufferOffset < bytes.byteLength) {
      const result = await this.#handle.write(
        bytes,
        bufferOffset,
        bytes.byteLength - bufferOffset,
        this.#writeOffset
      );
      if (result.bytesWritten === 0) {
        throw new Error("Replay write made no progress.");
      }
      bufferOffset += result.bytesWritten;
      this.#writeOffset += result.bytesWritten;
    }
  }

  #assertOpen(): void {
    if (this.#writeFailure !== undefined) {
      throw new Error("Replay writer has failed.", {
        cause: this.#writeFailure
      });
    }
    if (this.#phase !== "open") {
      throw new Error(`Replay writer is ${this.#phase}.`);
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Preserve the original create/finalize failure.
  }
}
