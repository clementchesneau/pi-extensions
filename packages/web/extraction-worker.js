import { Worker } from 'node:worker_threads';

/**
 * Runs `module` in a worker thread with `data`, so that a large or hostile document never blocks
 * Pi. The worker is terminated on cancellation, after `timeoutMs`, or when its heap exceeds
 * `memoryLimitMb`; `limitError` describes the time limit.
 * @param {URL} module
 * @param {unknown} data
 * @param {{ signal?: AbortSignal, timeoutMs: number, limitError: () => Error, memoryLimitMb?: number, transferList?: any[] }} options
 */
export function runExtractionWorker(module, data, { signal, timeoutMs, limitError, memoryLimitMb, transferList }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(module, {
      workerData: data,
      transferList,
      ...(memoryLimitMb ? { resourceLimits: { maxOldGenerationSizeMb: memoryLimitMb } } : {}),
    });
    const finish = (settle, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      settle(value);
    };
    const abort = () => finish(reject, signal?.reason);
    const timer = setTimeout(() => finish(reject, limitError()), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', result => finish(resolve, result));
    worker.once('error', error => finish(reject, error));
    worker.once('exit', code => finish(reject, new Error(`Extraction stopped (exit code ${code}).`)));
  });
}
