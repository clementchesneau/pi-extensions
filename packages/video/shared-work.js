/**
 * Work that parallel calls share, once per key, such as a download two tools need. Each call waits
 * on its own terms: a cancelled call stops waiting at once, and the work itself is cancelled only
 * when no call waits for it any more. A failure is not kept, so a later call starts the work again.
 */
export class SharedWork {
  /** @type {Map<string, { promise: Promise<any>, controller: AbortController, waiting: number, settled: boolean, at: number }>} */
  #entries = new Map();

  /** @param {{ now?: () => number }} [options] */
  constructor({ now = Date.now } = {}) {
    this.now = now;
  }

  /**
   * The result of `load` for this key, started now unless it already was less than `maxAgeMs` ago.
   * @template T
   * @param {string} key
   * @param {(signal: AbortSignal) => Promise<T>} load receives the signal of the shared work
   * @param {AbortSignal} [signal] the caller's
   * @param {{ maxAgeMs?: number }} [options]
   * @returns {Promise<T>}
   */
  run(key, load, signal, { maxAgeMs = Number.POSITIVE_INFINITY } = {}) {
    const existing = this.#entries.get(key);
    if (existing && this.now() - existing.at < maxAgeMs) return this.#wait(key, existing, signal);
    const controller = new AbortController();
    const entry = { promise: load(controller.signal), controller, waiting: 0, settled: false, at: this.now() };
    this.#entries.set(key, entry);
    entry.promise.then(
      () => (entry.settled = true),
      () => {
        entry.settled = true;
        this.#forget(key, entry);
      },
    );
    return this.#wait(key, entry, signal);
  }

  /** The work started for this key, waited for as `run` does, or undefined. */
  find(key, signal) {
    const entry = this.#entries.get(key);
    return entry && this.#wait(key, entry, signal);
  }

  /** Forgets every entry and cancels the work still running. */
  clear() {
    for (const entry of this.#entries.values()) entry.controller.abort();
    this.#entries.clear();
  }

  #forget(key, entry) {
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
  }

  #wait(key, entry, signal) {
    if (entry.settled) return entry.promise;
    if (signal?.aborted) return Promise.reject(signal.reason);
    entry.waiting++;
    return new Promise((resolve, reject) => {
      let waiting = true;
      const leave = () => {
        if (!waiting) return false;
        waiting = false;
        signal?.removeEventListener('abort', cancel);
        entry.waiting--;
        return true;
      };
      const cancel = () => {
        if (!leave()) return;
        if (entry.waiting === 0 && !entry.settled) {
          // Forgotten first, so a call arriving now starts the work again instead of joining it.
          this.#forget(key, entry);
          entry.controller.abort(signal?.reason);
        }
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      entry.promise.then(
        value => leave() && resolve(value),
        error => leave() && reject(error),
      );
    });
  }
}
