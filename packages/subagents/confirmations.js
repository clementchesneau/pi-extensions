/** Launch confirmations shown one at a time; cancelling a run settles its pending confirmation as declined. */
export class ConfirmationQueue {
  #tail = Promise.resolve();
  #cancels = new WeakMap();

  /**
   * @param {object} run
   * @param {() => boolean} isPending whether `run` still awaits confirmation when its turn comes
   * @param {(signal: AbortSignal) => Promise<unknown>} ask
   */
  async request(run, isPending, ask) {
    const controller = new AbortController();
    let cancel;
    const cancelled = new Promise(resolve => {
      cancel = () => {
        controller.abort();
        resolve(false);
      };
    });
    this.#cancels.set(run, cancel);
    const queued = this.#tail.then(() => {
      if (!isPending()) throw new Error('Subagent launch cancelled before confirmation');
      return Promise.race([ask(controller.signal), cancelled]);
    });
    this.#tail = queued.catch(() => {});
    try {
      return Boolean(await queued);
    } finally {
      if (this.#cancels.get(run) === cancel) this.#cancels.delete(run);
    }
  }

  cancel(run) {
    this.#cancels.get(run)?.();
  }
}
