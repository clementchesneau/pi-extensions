import { resolve } from 'node:path';
import { LspClient } from './client.js';
import { findWorkspaceRoot, languageForPath, resolveTypeScriptServer } from './languages.js';

function abortError() {
  return new DOMException('code_nav request cancelled', 'AbortError');
}

function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
  });
}

export class CodeNavManager {
  /**
   * @param {{
   *   idleMs?: number,
   *   clientFactory?: (options: any) => LspClient,
   *   findRoot?: typeof findWorkspaceRoot,
   *   resolveServer?: typeof resolveTypeScriptServer,
   *   clientOptions?: { onCrash?: (error: Error, client: LspClient) => void, [option: string]: unknown },
   * }} [options]
   */
  constructor({
    idleMs = 5 * 60_000,
    clientFactory = options => new LspClient(options),
    findRoot = findWorkspaceRoot,
    resolveServer = resolveTypeScriptServer,
    clientOptions = {},
  } = {}) {
    this.idleMs = idleMs;
    this.clientFactory = clientFactory;
    this.findRoot = findRoot;
    this.resolveServer = resolveServer;
    this.clientOptions = clientOptions;
    this.entries = new Map();
    this.closing = new Set();
  }

  get size() {
    return this.entries.size;
  }

  async navigate(params, cwd, signal) {
    if (this.closed) throw new Error('code_nav manager is closed. Reload the extension before making another request.');
    signal?.throwIfAborted();
    const cleanPath = params.path.startsWith('@') ? params.path.slice(1) : params.path;
    const path = resolve(cwd, cleanPath);
    if (!languageForPath(path)) {
      throw new Error(
        `Unsupported file type for code_nav: ${params.path}. Supported: TypeScript, TSX, JavaScript, JSX, MTS, CTS, MJS and CJS.`,
      );
    }
    const root = await waitFor(this.findRoot(path, cwd), signal);
    if (this.closed) throw new Error('code_nav manager is closed. Reload the extension before making another request.');
    signal?.throwIfAborted();
    const entry = this.#entry(root, cwd);
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.active += 1;
    try {
      const client = await waitFor(entry.promise, signal);
      signal?.throwIfAborted();
      return await client.navigate({ ...params, path }, signal);
    } finally {
      entry.active -= 1;
      if (entry.active === 0 && this.entries.get(root) === entry) this.#armIdle(root, entry);
    }
  }

  #entry(root, cwd) {
    if (this.closed) throw new Error('code_nav manager is closed. Reload the extension before making another request.');
    const existing = this.entries.get(root);
    if (existing) return existing;

    const entry = { active: 0, client: undefined, idleTimer: undefined, promise: undefined };
    entry.promise = (async () => {
      const server = await this.resolveServer(root, cwd);
      const client = this.clientFactory({
        root,
        ...server,
        ...this.clientOptions,
        onCrash: (error, crashedClient) => {
          this.#evict(root, entry, crashedClient).catch(() => {});
          this.clientOptions.onCrash?.(error, crashedClient);
        },
      });
      entry.client = client;
      await client.start();
      return client;
    })().catch(async error => {
      if (this.entries.get(root) === entry) this.entries.delete(root);
      if (entry.client) await this.#trackClosing(entry.client.close().catch(() => {}));
      throw error;
    });
    this.entries.set(root, entry);
    return entry;
  }

  #armIdle(root, entry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.active === 0) this.#evict(root, entry).catch(() => {});
    }, this.idleMs);
    entry.idleTimer.unref?.();
  }

  #trackClosing(promise) {
    this.closing.add(promise);
    promise.then(
      () => this.closing.delete(promise),
      () => this.closing.delete(promise),
    );
    return promise;
  }

  #evict(root, entry, expectedClient) {
    if (this.entries.get(root) !== entry) return Promise.resolve();
    if (expectedClient && entry.client !== expectedClient) return Promise.resolve();
    this.entries.delete(root);
    clearTimeout(entry.idleTimer);
    return this.#trackClosing(
      (async () => {
        let client = entry.client;
        if (!client) {
          try {
            client = await entry.promise;
          } catch {
            return;
          }
        }
        await client.close();
      })(),
    );
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const entries = [...this.entries.values()];
      this.entries.clear();
      for (const entry of entries) clearTimeout(entry.idleTimer);
      const ownedClosures = entries.map(async entry => {
        try {
          const client = entry.client ?? (await entry.promise);
          await client.close();
        } catch {
          await entry.client?.close().catch(() => {});
        }
      });
      await Promise.allSettled([...ownedClosures, ...this.closing]);
    })();
    return this.closePromise;
  }
}
