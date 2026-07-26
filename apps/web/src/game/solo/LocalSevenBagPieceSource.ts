import {
  createSharedSevenBag,
  readSharedSevenBagWindow,
  type PieceKind,
  type SevenBagSeed,
  type SharedSevenBagState,
  type SimulationPieceSource
} from "@tetr-d/game-core";

export class LocalSevenBagPieceSource implements SimulationPieceSource {
  #state: SharedSevenBagState;
  #cursor = 0;

  constructor(seed: SevenBagSeed) {
    this.#state = createSharedSevenBag(seed);
  }

  draw(): PieceKind {
    const piece = this.peek(1)[0];
    if (piece === undefined) throw new Error("Seven-bag source was exhausted.");
    this.#cursor += 1;
    return piece;
  }

  peek(count: number): readonly PieceKind[] {
    const window = readSharedSevenBagWindow(this.#state, this.#cursor, count);
    this.#state = window.state;
    return window.pieces;
  }

  getCursor(): number {
    return this.#cursor;
  }
}
