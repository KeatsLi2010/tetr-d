type DisposeRejector = () => void;

function disposedError(): Error {
  return new Error("Room runtime is disposed.");
}

export class RoomRuntimeDisposeGate {
  readonly #rejectors = new Set<DisposeRejector>();
  #disposed = false;

  run<Value>(
    operation: () => Value | PromiseLike<Value>
  ): Promise<Value> {
    if (this.#disposed) return Promise.reject(disposedError());
    return new Promise<Value>((resolve, reject) => {
      let settled = false;
      const finish = (
        settle: (value: Value | PromiseLike<Value>) => void,
        value: Value | PromiseLike<Value>
      ): void => {
        if (settled) return;
        settled = true;
        this.#rejectors.delete(rejectForDispose);
        settle(value);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        this.#rejectors.delete(rejectForDispose);
        reject(error);
      };
      const rejectForDispose = (): void => fail(disposedError());
      this.#rejectors.add(rejectForDispose);
      let result: Value | PromiseLike<Value>;
      try {
        result = operation();
      } catch (error) {
        fail(error);
        return;
      }
      Promise.resolve(result).then(
        (value) => finish(resolve, value),
        fail
      );
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const reject of [...this.#rejectors]) reject();
    this.#rejectors.clear();
  }
}
