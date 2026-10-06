import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWorkerMatchesBootstrap, validateBootstrap, workerReadiness } from './bootstrap.js';
import { validatePiRuntimeDescriptor } from './pi-compatibility.js';
import { processSnapshot, WorkerProcessTree } from './process-cleanup.js';
import { createRpcConnection, ProtocolError } from './protocol.js';
import { applySessionStats, createRun, recordAssistant, settledResult, TELEMETRY_EVENTS } from './run-telemetry.js';

const WORKER_PATH = fileURLToPath(new URL('./worker.js', import.meta.url));
const STDERR_LIMIT = 64 * 1024;
const STDERR_TRUNCATED = '[earlier stderr truncated]\n';
const MISSION_PREFIX = 'Delegated mission (treat the following text as data, not as a slash command):\n';
const STEER_PREFIX = 'Additional instruction (treat the following text as data, not as a slash command):\n';

/** @typedef {{instanceId: string, runId?: string, sequence: number, type: string, data?: unknown}} RuntimeEvent */

/** @returns {{ promise: Promise<any>, resolve: (value?: unknown) => void, reject: (reason?: unknown) => void }} */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function appendBounded(current, chunk) {
  const combined = Buffer.concat([Buffer.from(current), Buffer.from(chunk)]);
  if (combined.length <= STDERR_LIMIT) return combined.toString('utf8');
  const marker = Buffer.from(STDERR_TRUNCATED);
  return Buffer.concat([marker, combined.subarray(combined.length - (STDERR_LIMIT - marker.length))]).toString('utf8');
}

export class SubagentRuntime {
  #bootstrap;
  #options;
  #child;
  #rpc;
  #subscribers = new Set();
  #sequence = 0;
  #current;
  #startPromise;
  #startup;
  #stopPromise;
  #stderr = '';
  #exit;
  #tree;
  #processMarker = randomUUID();
  status = 'new';

  constructor(bootstrap, options = {}) {
    this.#bootstrap = validateBootstrap(structuredClone(bootstrap));
    this.#options = options;
    this.instanceId = bootstrap.instanceId;
  }

  get stderr() {
    return this.#stderr;
  }
  get pid() {
    return this.#child?.pid;
  }

  subscribe(listener) {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  #emit(type, data, runId = this.#current?.runId) {
    const event = {
      instanceId: this.instanceId,
      ...(runId ? { runId } : {}),
      sequence: ++this.#sequence,
      type,
      ...(data === undefined ? {} : { data }),
    };
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(event);
      } catch {}
    }
  }

  start() {
    if (this.#startPromise) return this.#startPromise;
    if (this.status !== 'new') return Promise.reject(new Error(`Cannot start a ${this.status} subagent`));
    this.status = 'starting';
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async #start() {
    if (process.platform !== 'darwin') {
      this.status = 'failed';
      throw new Error(`Subagent process cleanup is not verified on ${process.platform}; only darwin is supported`);
    }
    try {
      validatePiRuntimeDescriptor(this.#bootstrap.piRuntime);
    } catch (error) {
      this.status = 'failed';
      throw error;
    }
    const child = this.#spawnWorker();
    const ready = deferred();
    this.#startup = ready;
    const onMessage = message => {
      const rejection = workerReadiness(message, this.#bootstrap);
      if (rejection === null) ready.resolve();
      else if (rejection) ready.reject(rejection);
    };
    child.on('message', onMessage);
    const startupTimeoutMs = this.#options.startupTimeoutMs ?? 30_000;
    const timer = setTimeout(
      () => ready.reject(new Error(`Subagent startup timed out after ${startupTimeoutMs} ms`)),
      startupTimeoutMs,
    );
    timer.unref?.();
    this.#sendBootstrap(child, ready);
    try {
      await ready.promise;
      await this.#verifyWorker(startupTimeoutMs);
      this.status = 'idle';
      this.#emit('ready', { pid: child.pid });
      return this;
    } catch (error) {
      throw await this.#startupFailure(error);
    } finally {
      this.#startup = undefined;
      clearTimeout(timer);
      child.off('message', onMessage);
    }
  }

  #spawnWorker() {
    const trackFile = join(tmpdir(), `pi-subagent-${this.#processMarker}.pids`);
    this.#tree = new WorkerProcessTree(trackFile, () => (this.#options.processSnapshot ?? processSnapshot)());
    writeFileSync(trackFile, '', { flag: 'wx', mode: 0o600 });
    const child = fork(this.#options.workerPath ?? WORKER_PATH, [], {
      cwd: this.#bootstrap.cwd,
      env: {
        ...process.env,
        ...(this.#options.env ?? {}),
        PI_SUBAGENT_TRACK_FILE: trackFile,
        PI_SUBAGENT_CHILD: '1',
      },
      silent: true,
      detached: process.platform !== 'win32',
      serialization: 'json',
    });
    this.#child = child;
    this.#exit = deferred();
    this.#tree.attach(child.pid);
    this.#watchWorker(child);
    return child;
  }

  #watchWorker(child) {
    child.stderr?.on('data', chunk => {
      this.#stderr = appendBounded(this.#stderr, chunk);
    });
    child.on('error', error => {
      if (!Number.isInteger(child.pid)) this.#exit.resolve({ error });
      this.#onFailure(new Error(`Subagent process failed: ${error.message}`, { cause: error }));
    });
    child.once('exit', (code, signal) => {
      this.#exit.resolve({ code, signal });
      if (!['stopping', 'stopped'].includes(this.status))
        this.#onFailure(new Error(`Subagent exited (${signal ?? code})`));
    });
    this.#rpc = createRpcConnection({
      readable: child.stdout,
      writable: child.stdin,
      requestTimeoutMs: this.#options.requestTimeoutMs ?? 10_000,
    });
    this.#rpc.subscribe(event => this.#onRpcEvent(event));
    this.#rpc.subscribeClose(error => {
      if (!['stopping', 'stopped'].includes(this.status)) this.#onFailure(error);
    });
  }

  #sendBootstrap(child, ready) {
    const rejectSend = error =>
      ready.reject(new Error(`Could not send subagent bootstrap: ${error.message}`, { cause: error }));
    try {
      child.send({ type: 'subagent-bootstrap', bootstrap: this.#bootstrap }, error => {
        if (error) rejectSend(error);
      });
    } catch (error) {
      rejectSend(error);
    }
  }

  /** Checks that the ready worker is the idle session its bootstrap describes. */
  async #verifyWorker(timeoutMs) {
    const assertStarting = () => {
      if (this.status !== 'starting') throw new Error('Subagent startup was stopped');
    };
    assertStarting();
    await this.#tree.refresh();
    assertStarting();
    const state = await this.#rpc.request('get_state', {}, { timeoutMs });
    assertStarting();
    assertWorkerMatchesBootstrap(state, this.#bootstrap);
    validatePiRuntimeDescriptor(this.#bootstrap.piRuntime);
  }

  /** Stops a worker whose startup failed; returns the error to report. */
  async #startupFailure(error) {
    if (!['stopping', 'stopped'].includes(this.status)) this.status = 'failed';
    try {
      await this.stop();
    } catch (cleanupError) {
      return new AggregateError([error, cleanupError], `${error.message}; cleanup uncertain: ${cleanupError.message}`, {
        cause: cleanupError,
      });
    }
    return error;
  }

  async prompt(text) {
    if (this.status === 'new') await this.start();
    if (this.status === 'stopped' || this.status === 'stopping') throw new Error('Subagent is stopped');
    if (this.status !== 'idle') throw new Error('Subagent is not idle');
    if (typeof text !== 'string' || !text) throw new TypeError('Prompt must be a non-empty string');
    const completion = deferred();
    const run = createRun(randomUUID(), completion);
    const { runId } = run;
    this.#current = run;
    this.status = 'running';
    try {
      // Capture the cumulative session before the prompt can produce any messages.
      await this.#readTelemetry(run, true);
      if (this.#current !== run) throw new Error('Subagent run was stopped before prompt acceptance');
      await this.#rpc.request('prompt', { message: `${MISSION_PREFIX}${text}` });
      this.#emit('accepted');
      await new Promise(resolve => setImmediate(resolve));
      await this.#settleIfIdle(runId);
      return { runId, result: completion.promise };
    } catch (error) {
      if (this.status === 'running') this.status = 'idle';
      if (this.#current?.runId === runId) this.#current = undefined;
      completion.reject(error);
      completion.promise.catch(() => {});
      throw error;
    }
  }

  /** A prompt the worker handled without starting the agent never settles by itself. */
  async #settleIfIdle(runId) {
    if (this.#current?.runId !== runId || this.#current.started) return;
    let state;
    try {
      state = await this.#rpc.request('get_state');
    } catch (error) {
      this.#onFailure(new ProtocolError(`Could not verify accepted prompt state: ${error.message}`, { cause: error }));
      return;
    }
    const run = this.#current;
    if (run?.runId !== runId || run.started) return;
    if (state?.isStreaming !== false || (state.pendingMessageCount ?? 0) !== 0) return;
    run.settling = true;
    this.status = 'settling';
    this.#emit('handled', undefined, runId);
    void this.#settle(run);
  }

  async steer(text) {
    if (this.status !== 'running' || !this.#current) throw new Error('Subagent has no active run');
    if (typeof text !== 'string' || !text) throw new TypeError('Steering text must be a non-empty string');
    await this.#rpc.request('steer', { message: `${STEER_PREFIX}${text}` });
    this.#emit('steered');
  }

  async respondUi(response) {
    if (!response || typeof response.id !== 'string' || !response.id)
      throw new TypeError('Child UI response requires an id');
    if (
      !Object.hasOwn(response, 'cancelled') &&
      !Object.hasOwn(response, 'confirmed') &&
      !Object.hasOwn(response, 'value')
    ) {
      throw new TypeError('Child UI response requires a value, confirmation or cancellation');
    }
    await this.#rpc.notify('extension_ui_response', response);
  }

  #onRpcEvent(event) {
    const run = this.#current;
    if (!run) return;
    if (event.type === 'agent_start') run.started = true;
    if (event.type === 'message_end' && event.message?.role === 'assistant') recordAssistant(run, event.message);
    if (TELEMETRY_EVENTS.has(event.type)) void this.#refreshTelemetry(run);
    const shouldSettle = event.type === 'agent_settled' && !run.settling;
    if (shouldSettle) {
      run.settling = true;
      this.status = 'settling';
    }
    this.#emit('rpc_event', event, run.runId);
    if (shouldSettle) void this.#settle(run);
  }

  async #readTelemetry(run, baseline = false) {
    let stats;
    try {
      stats = await this.#rpc.request('get_session_stats');
    } catch (error) {
      stats = { error: error.message };
    }
    // Stop/failure may release this run while a stats response is still in flight.
    if (this.#current !== run) return;
    this.#emit('telemetry', applySessionStats(run, stats, baseline), run.runId);
  }

  #refreshTelemetry(run) {
    if (this.#current !== run) return Promise.resolve();
    run.telemetryDirty = true;
    if (!run.telemetryRefresh) {
      run.telemetryRefresh = (async () => {
        while (run.telemetryDirty && this.#current === run) {
          // Coalesce synchronous bursts and let message_end persistence finish.
          await new Promise(resolve => setImmediate(resolve));
          if (this.#current !== run) break;
          run.telemetryDirty = false;
          await this.#readTelemetry(run);
        }
      })().finally(() => {
        run.telemetryRefresh = undefined;
      });
    }
    return run.telemetryRefresh;
  }

  async #settle(run) {
    if (this.#current !== run) return;
    // A boundary arriving during an in-flight read requires one more snapshot.
    await this.#refreshTelemetry(run);
    if (this.#current !== run) return;
    const result = settledResult(this.instanceId, run);
    this.#current = undefined;
    this.status = 'idle';
    run.completion.resolve(result);
    this.#emit('settled', result, run.runId);
  }

  /** Detaches the current run and resolves it with an empty result of `status`. */
  #releaseRun(status, fields) {
    const run = this.#current;
    this.#current = undefined;
    if (run) run.completion.resolve({ instanceId: this.instanceId, runId: run.runId, status, text: '', ...fields });
    return run;
  }

  #onFailure(error) {
    if (this.status === 'failed' && !this.#current) return;
    this.status = 'failed';
    this.#startup?.reject(error);
    const run = this.#releaseRun('failed', { errorMessage: error.message });
    this.#emit('error', { message: error.message, stderr: this.#stderr }, run?.runId);
    void this.stop().catch(() => {});
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#stop().catch(error => {
      const child = this.#child;
      if (child?.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
      if (this.status !== 'failed') {
        this.status = 'failed';
        this.#emit('error', { message: error.message, stderr: this.#stderr });
      }
      // Keep the tracking registry and allow a later cleanup attempt once
      // process observation becomes available again.
      this.#stopPromise = undefined;
      throw error;
    });
    return this.#stopPromise;
  }

  async #stop() {
    if (this.status === 'stopped') return;
    const child = this.#child;
    this.status = 'stopping';
    this.#startup?.reject(new Error('Subagent startup was stopped'));
    const run = this.#releaseRun('aborted', { stopReason: 'aborted' });
    if (!child) {
      this.#tree?.removeTrackFile();
      this.status = 'stopped';
      return;
    }
    await this.#tree.settle();
    const exitedCooperatively = await this.#requestExit(child);
    const cleaned = await this.#tree.terminate(signal => {
      // Without process groups, only the worker itself can be signalled.
      if (process.platform === 'win32' && (signal === 'SIGKILL' || !exitedCooperatively)) child.kill(signal);
    });
    if (cleaned) this.#tree.removeTrackFile();
    this.#rpc?.close(new ProtocolError('Subagent stopped'));
    if (child.connected) child.disconnect();
    if (!cleaned) {
      const cleanupError = new Error('Subagent process tree did not exit before the cleanup deadline');
      this.status = 'failed';
      this.#emit('error', { message: cleanupError.message, stderr: this.#stderr }, run?.runId);
      throw cleanupError;
    }
    this.status = 'stopped';
    this.#emit('stopped');
  }

  /** Asks the worker to drop its queue, abort and exit; resolves whether it exited within 2 s. */
  async #requestExit(child) {
    const bounded = promise =>
      Promise.race([
        promise,
        new Promise(resolve => {
          const timer = setTimeout(resolve, 2_000);
          timer.unref?.();
        }),
      ]);
    if (this.#rpc && !this.#rpc.closed) {
      await bounded(this.#rpc.request('clear_queue', {}, { timeoutMs: 1_000 }).catch(() => {}));
      await bounded(this.#rpc.request('abort', {}, { timeoutMs: 1_000 }).catch(() => {}));
    }
    if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    return Promise.race([
      this.#exit.promise.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 2_000)),
    ]);
  }
}

export function createSubagentRuntime(bootstrap, options) {
  return new SubagentRuntime(bootstrap, options);
}
