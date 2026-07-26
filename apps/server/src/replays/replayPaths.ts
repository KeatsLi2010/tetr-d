import { dirname, resolve } from "node:path";

const MATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export interface ReplayPaths {
  readonly rootDirectory: string;
  readonly partialPath: string;
  readonly finalPath: string;
}

export function assertSafeReplayMatchId(matchId: string): void {
  if (
    !MATCH_ID_PATTERN.test(matchId)
    || WINDOWS_DEVICE_NAME.test(matchId)
  ) {
    throw new TypeError(
      "matchId must be 1-128 ASCII letters, digits, underscores, or hyphens."
    );
  }
}

export function resolveReplayPaths(
  rootDirectory: string,
  matchId: string
): ReplayPaths {
  assertSafeReplayMatchId(matchId);
  const resolvedRoot = resolve(rootDirectory);
  const finalPath = resolve(resolvedRoot, `${matchId}.jsonl`);
  const partialPath = resolve(resolvedRoot, `${matchId}.jsonl.partial`);
  if (
    dirname(finalPath) !== resolvedRoot
    || dirname(partialPath) !== resolvedRoot
  ) {
    throw new TypeError("Replay path escaped its configured root.");
  }
  return Object.freeze({
    rootDirectory: resolvedRoot,
    partialPath,
    finalPath
  });
}
