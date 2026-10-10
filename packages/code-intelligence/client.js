import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { CancellationTokenSource, createMessageConnection } from 'vscode-jsonrpc/node.js';
import {
  canonicalFileUri,
  createDeclarationProbeSpec,
  createProbeSpec,
  hasDiagnosticProbe,
  insertDiagnosticProbe,
  isDiagnosticProbe,
  shiftDiagnosticAfterProbe,
} from './diagnostic-probe.js';
import { languageForPath } from './languages.js';

const STDERR_LIMIT = 16_384;

function abortError(message = 'LSP request cancelled') {
  return new DOMException(message, 'AbortError');
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

function delay(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class LspClient {
  constructor({
    root,
    command,
    args = ['--stdio'],
    env = process.env,
    requestTimeoutMs = 10_000,
    diagnosticsTimeoutMs = 2_000,
    shutdownTimeoutMs = 1_000,
    onCrash,
  }) {
    this.root = root;
    this.command = command;
    this.args = args;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.diagnosticsTimeoutMs = diagnosticsTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.onCrash = onCrash;
    this.capabilities = {};
    this.documents = new Map();
    this.diagnosticProbeWaiters = new Map();
    this.probeGeneration = 0n;
    this.operationTail = Promise.resolve();
    this.stderr = '';
    this.closed = false;
    this.intentionalClose = false;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start();
    return this.startPromise;
  }

  async #start() {
    this.child = spawn(this.command, this.args, {
      cwd: this.root,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_LIMIT);
    });
    this.child.once('error', error => this.#handleCrash(error));
    this.child.once('exit', (code, signal) => {
      if (!this.intentionalClose)
        this.#handleCrash(
          new Error(`LSP server exited unexpectedly (${signal ?? `code ${code}`})${this.#stderrSuffix()}`),
        );
    });

    this.connection = createMessageConnection(this.child.stdout, this.child.stdin);
    this.connection.onRequest('workspace/configuration', params => (params?.items ?? []).map(() => null));
    this.connection.onRequest('client/registerCapability', () => null);
    this.connection.onRequest('workspace/workspaceFolders', () => [
      { uri: pathToFileURL(this.root).href, name: basename(this.root) },
    ]);
    this.connection.onNotification('textDocument/publishDiagnostics', params => this.#receiveDiagnostics(params));
    this.connection.onError(([error]) => this.#handleCrash(error));
    this.connection.onClose(() => {
      if (!this.intentionalClose)
        this.#handleCrash(new Error(`LSP connection closed unexpectedly${this.#stderrSuffix()}`));
    });
    this.connection.listen();

    const result = await this.#request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'pi-code-intelligence' },
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: basename(this.root) }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, symbol: {} },
        textDocument: {
          synchronization: { didSave: false, dynamicRegistration: false },
          documentSymbol: {},
          definition: {},
          references: {},
          hover: {},
          publishDiagnostics: { versionSupport: true },
        },
      },
    });
    this.capabilities = result?.capabilities ?? {};
    await this.connection.sendNotification('initialized', {});
    return this;
  }

  async navigate(params, signal) {
    await waitFor(this.start(), signal);
    const operation = this.operationTail.then(async () => {
      signal?.throwIfAborted();
      return this.#navigate(params, signal);
    });
    this.operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return waitFor(operation, signal);
  }

  async #navigate(params, signal) {
    await this.#refreshOpenDocuments(params.path);
    if (params.action === 'diagnostics') return this.#collectDiagnostics(params.path, signal);
    const synced = await this.#syncDocument(params.path);
    const position =
      params.line === undefined
        ? undefined
        : {
            line: params.line - 1,
            character: params.column - 1,
          };
    const textDocument = { uri: synced.uri };

    switch (params.action) {
      case 'symbols':
        if (params.query !== undefined) {
          this.#requireCapability('workspaceSymbolProvider', 'Workspace symbols');
          return this.#request('workspace/symbol', { query: params.query }, signal);
        }
        this.#requireCapability('documentSymbolProvider', 'Document symbols');
        return this.#request('textDocument/documentSymbol', { textDocument }, signal);
      case 'definition':
        this.#requireCapability('definitionProvider', 'Definition');
        return this.#request('textDocument/definition', { textDocument, position }, signal);
      case 'references':
        this.#requireCapability('referencesProvider', 'References');
        return this.#request(
          'textDocument/references',
          { textDocument, position, context: { includeDeclaration: true } },
          signal,
        );
      case 'hover':
        this.#requireCapability('hoverProvider', 'Hover');
        return this.#request('textDocument/hover', { textDocument, position }, signal);
      default:
        throw new Error(`Unknown code_nav action: ${params.action}`);
    }
  }

  #requireCapability(name, label) {
    if (!this.capabilities[name]) throw new Error(`${label} is not supported by this language server.`);
  }

  async #syncDocument(path) {
    const languageId = languageForPath(path);
    if (!languageId) throw new Error(`Unsupported file type for code_nav: ${path}`);
    const text = await readFile(path, 'utf8');
    const uri = pathToFileURL(path).href;
    const previous = this.documents.get(uri);
    const version = (previous?.version ?? 0) + 1;
    this.documents.set(uri, { version, text });
    if (!previous) {
      await this.connection.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId, version, text },
      });
    } else {
      await this.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    return { uri, version };
  }

  async #refreshOpenDocuments(targetPath) {
    for (const [uri, document] of this.documents) {
      const path = fileURLToPath(uri);
      if (path === targetPath) continue;
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await this.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
        this.documents.delete(uri);
        continue;
      }
      if (text === document.text) continue;
      const version = document.version + 1;
      this.documents.set(uri, { version, text });
      await this.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
  }

  async #collectDiagnostics(path, signal) {
    const synced = await this.#syncDocument(path);
    const document = this.documents.get(synced.uri);
    const declarationFile = /\.d\.(?:ts|mts|cts)$/i.test(path);
    const grammarProbe = declarationFile
      ? createDeclarationProbeSpec(++this.probeGeneration)
      : createProbeSpec(++this.probeGeneration, false);
    try {
      return await this.#runDiagnosticProbe(synced.uri, document, grammarProbe, signal);
    } catch (error) {
      if (error?.code !== 'CODE_NAV_DIAGNOSTIC_PROBE_TIMEOUT') throw error;
      const current = this.documents.get(synced.uri);
      return this.#runDiagnosticProbe(synced.uri, current, createProbeSpec(++this.probeGeneration, true), signal);
    }
  }

  async #runDiagnosticProbe(uri, document, probeSpec, signal) {
    const inserted = insertDiagnosticProbe(document.text, probeSpec.marker, fileURLToPath(uri));
    const probeVersion = document.version + 1;
    const probe = { ...probeSpec, line: inserted.line, mapping: inserted.mapping, version: probeVersion };
    const collection = this.#waitForDiagnosticProbe(uri, probe, signal);
    this.documents.set(uri, { version: probeVersion, text: inserted.text });
    try {
      await this.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: probeVersion },
        contentChanges: [{ text: inserted.text }],
      });
      return await collection;
    } finally {
      const version = probeVersion + 1;
      this.documents.set(uri, { version, text: document.text });
      await this.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: document.text }],
      });
    }
  }

  #waitForDiagnosticProbe(uri, probe, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter = { probe, latest: undefined, reject: undefined };
      const finish = callback => value => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.diagnosticProbeWaiters.delete(uri);
        callback(value);
      };
      const onAbort = () => finish(reject)(abortError());
      const timer = setTimeout(() => {
        if (!waiter.latest) {
          const error = /** @type {Error & { code?: string }} */ (
            new Error(`Timed out waiting for the diagnostic analysis probe after ${this.diagnosticsTimeoutMs}ms.`)
          );
          error.code = 'CODE_NAV_DIAGNOSTIC_PROBE_TIMEOUT';
          finish(reject)(error);
          return;
        }
        finish(resolve)({
          items: waiter.latest
            .filter(diagnostic => !isDiagnosticProbe(diagnostic, probe))
            .map(diagnostic => shiftDiagnosticAfterProbe(diagnostic, uri, probe.mapping)),
          incomplete: true,
          reason: 'LSP publishDiagnostics has no completion marker; later diagnostics may still arrive.',
        });
      }, this.diagnosticsTimeoutMs);
      timer.unref?.();
      waiter.reject = finish(reject);
      this.diagnosticProbeWaiters.set(uri, waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  #receiveDiagnostics(params) {
    const diagnostics = params.diagnostics ?? [];
    const probeWaiter = this.diagnosticProbeWaiters.get(canonicalFileUri(params.uri));
    if (!probeWaiter) return;
    if (params.version !== undefined && params.version !== probeWaiter.probe.version) return;
    if (hasDiagnosticProbe(diagnostics, probeWaiter.probe)) probeWaiter.latest = diagnostics;
  }

  #request(method, params, signal, timeoutMs = this.requestTimeoutMs) {
    if (signal?.aborted) return Promise.reject(abortError());
    const cancellation = new CancellationTokenSource();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        cancellation.dispose();
        callback(value);
      };
      const onAbort = () => {
        cancellation.cancel();
        finish(reject, abortError());
      };
      const timer = setTimeout(() => {
        cancellation.cancel();
        finish(reject, new Error(`LSP ${method} timed out after ${timeoutMs}ms.${this.#stderrSuffix()}`));
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });

      this.connection.sendRequest(method, params, cancellation.token).then(
        value => finish(resolve, value),
        error =>
          finish(reject, new Error(`LSP ${method} failed: ${error.message}${this.#stderrSuffix()}`, { cause: error })),
      );
    });
  }

  #stderrSuffix() {
    return this.stderr.trim() ? ` Server stderr: ${this.stderr.trim()}` : '';
  }

  #handleCrash(error) {
    if (this.crashError || this.intentionalClose) return;
    this.crashError = error;
    for (const waiter of this.diagnosticProbeWaiters.values()) waiter.reject(error);
    this.diagnosticProbeWaiters.clear();
    this.onCrash?.(error, this);
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.#close();
    return this.closePromise;
  }

  async #close() {
    this.intentionalClose = true;
    if (!this.child) {
      this.closed = true;
      return;
    }
    if (this.child.exitCode === null && this.connection) {
      try {
        await Promise.race([
          this.#request('shutdown', null, undefined, this.shutdownTimeoutMs),
          delay(this.shutdownTimeoutMs),
        ]);
        await this.connection.sendNotification('exit');
      } catch {
        // Fall through to bounded process termination.
      }
      await Promise.race([new Promise(resolve => this.child.once('exit', resolve)), delay(this.shutdownTimeoutMs)]);
    }
    if (this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => this.child.once('exit', resolve)), delay(200)]);
    }
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
    this.connection?.dispose();
    this.closed = true;
  }
}
