import type { DgLabChannel, DgLabOutputChannel } from "./dglabTypes.ts";

export const DGLAB_CHANNELS: readonly DgLabChannel[] = Object.freeze(["A", "B"]);

export function outputChannels(selection: DgLabOutputChannel): readonly DgLabChannel[] {
  return selection === "both" ? DGLAB_CHANNELS : [selection];
}
