import { randomUUID } from 'node:crypto';
import { AgentRegistry, assertAgentInput } from './agent-registry.js';
import { ConfirmationQueue } from './confirmations.js';
import { RunActivity } from './run-activity.js';
import { RunJournal } from './run-journal.js';
import {
  ACTIVE_STATES,
  awaitRuns,
  compactRun,
  deferred,
  isSettled,
  now,
  publicAgent,
  publicRun,
  settledOutcome,
  TERMINAL_STATES,
} from './run-state.js';

const clone = value => structuredClone(value);

function assertNotAborted(signal) {
  if (signal?.aborted) throw new Error('Subagent launch aborted before acceptance');
}

function assertAwaitingConfirmation(run) {
  if (run.state !== 'awaiting_confirmation') throw new Error('Subagent launch cancelled before acceptance');
}

const newRun = (activity, fields) => ({
  runId: randomUUID(),
  state: 'awaiting_confirmation',
  startedAt: now(),
  activity,
  ...fields,
});

/**
 * Agents and runs are plain records owned by the registry; the injected callbacks only receive them.
 * @typedef {{
 *   ownerSessionId?: string,
 *   branchId?: string,
 *   getConfig?: () => Promise<{ autoDelegate: boolean, maxConcurrent: number }>,
 *   createRuntime?: (agent: any) => Promise<import('./runtime.js').SubagentRuntime>,
 *   persist?: (agent: any) => Promise<unknown>,
 *   saveResult?: (agent: any, run: any, text: string) => Promise<void>,
 *   readResult?: (agent: any, run: any, options: { cursor?: number, maxBytes?: number }) => Promise<object>,
 *   readTranscript?: (agent: any, options: { sessionFile?: string, cursor?: number, maxBytes?: number }) => Promise<object>,
 *   handleUiRequest?: (agent: any, request: any, runtime: any) => Promise<unknown>,
 *   confirm?: (request: { agent: any, run: any }, options: { signal?: AbortSignal }) => Promise<unknown>,
 * }} SubagentManagerOptions
 */

export class SubagentManager {
  #registry;
  #activity;
  #journal;
  #config;
  #createRuntime;
  #saveResult;
  #readResult;
  #readTranscript;
  #closed = false;
  #confirmations = new ConfirmationQueue();
  #runtimeClosures = new WeakMap();

  /** @param {SubagentManagerOptions} [options] */
  constructor({
    ownerSessionId,
    branchId,
    getConfig,
    createRuntime,
    persist,
    saveResult,
    readResult,
    readTranscript,
    handleUiRequest,
    confirm,
  } = {}) {
    if (!ownerSessionId || !branchId || typeof getConfig !== 'function' || typeof createRuntime !== 'function') {
      throw new TypeError('ownerSessionId, branchId, getConfig and createRuntime are required');
    }
    this.ownerSessionId = ownerSessionId;
    this.branchId = branchId;
    this.#registry = new AgentRegistry([branchId]);
    this.#config = getConfig;
    this.#createRuntime = createRuntime;
    this.#journal = new RunJournal(persist);
    this.#saveResult = saveResult;
    this.#readResult = readResult;
    this.#readTranscript = readTranscript;
    this.#activity = new RunActivity({
      publish: (agent, run, options) => this.#journal.publish(agent, run, options),
      handleUiRequest,
    });
    this.confirm = confirm;
  }

  subscribe(listener) {
    return this.#journal.subscribe(listener);
  }
  // Ephemeral display events: never copy streamed text or tool output into persisted metadata.
  subscribeActivity(listener) {
    return this.#activity.subscribe(listener);
  }

  activitySnapshot(agentId) {
    const run = this.#registry.lookup(agentId)?.runs.at(-1);
    return run ? this.#activity.snapshot(run) : undefined;
  }

  restore(agents, { branchIds = [this.branchId] } = {}) {
    if (!Array.isArray(agents)) throw new TypeError('Subagent restore data must be an array');
    this.#registry.setBranchIds(branchIds);
    this.#registry.restore(agents, this.ownerSessionId);
  }

  list(options) {
    return this.#registry.list(options);
  }

  compactAgents() {
    return this.#registry.compact();
  }

  activeAgentIds() {
    return this.#registry.activeIds();
  }

  findAgent(id) {
    return this.#registry.find(id);
  }

  getAgent(agentId) {
    return publicAgent(this.#registry.get(agentId));
  }

  setBranchId(branchId, branchIds = [branchId]) {
    if (typeof branchId !== 'string' || !branchId) throw new TypeError('branchId must be a non-empty string');
    this.branchId = branchId;
    this.#registry.setBranchIds([branchId, ...branchIds]);
  }

  assertCurrentBranch(agentId) {
    return this.#registry.assertCurrentBranch(agentId);
  }

  async #requestConfirmation(agent, run, config) {
    if (config.autoDelegate) return true;
    if (typeof this.confirm !== 'function')
      throw new Error('Subagent confirmation is unavailable without a capable UI');
    return this.#confirmations.request(
      run,
      () => run.state === 'awaiting_confirmation' && !this.#closed,
      signal => this.confirm(clone({ agent: publicAgent(agent), run: publicRun(run) }), { signal }),
    );
  }

  /** Asks for confirmation when required, then reserves a concurrency slot. */
  async #admit(agent, run, signal) {
    assertNotAborted(signal);
    if (this.#closed) throw new Error('Subagent session is closed');
    const config = await this.#config();
    if (!config || !Number.isSafeInteger(config.maxConcurrent) || config.maxConcurrent < 1)
      throw new Error('Subagent configuration is unavailable');
    await this.#confirmOrDecline(agent, run, config, signal);
    // The slot is reserved synchronously before the first startup await.
    const refreshed = await this.#config();
    if (!refreshed.autoDelegate && config.autoDelegate) await this.#confirmOrDecline(agent, run, refreshed);
    assertNotAborted(signal);
    assertAwaitingConfirmation(run);
    if (this.#registry.activeRunCount() >= refreshed.maxConcurrent)
      throw new Error(`Subagent capacity is occupied (maximum ${refreshed.maxConcurrent})`);
    await this.#journal.transition(agent, run, 'starting');
  }

  async #confirmOrDecline(agent, run, config, signal) {
    const confirmed = await this.#requestConfirmation(agent, run, config);
    assertNotAborted(signal);
    assertAwaitingConfirmation(run);
    if (confirmed) return;
    await this.#journal.terminal(agent, run, 'cancelled', { error: 'Subagent launch declined by the user' });
    throw new Error('Subagent launch declined by the user');
  }

  async #closeRuntime(agent) {
    const runtime = agent.runtime;
    if (!runtime) return;
    let closing = this.#runtimeClosures.get(runtime);
    if (!closing) {
      closing = Promise.resolve().then(() => runtime.stop());
      this.#runtimeClosures.set(runtime, closing);
    }
    try {
      await closing;
      if (agent.runtime === runtime) {
        agent.runtime = undefined;
        agent.runtimeUiAttached = false;
      }
    } finally {
      if (this.#runtimeClosures.get(runtime) === closing) this.#runtimeClosures.delete(runtime);
    }
  }

  async #failRun(agent, run, error, state = 'failed') {
    // A concurrent stop owns this run and keeps its slot until the child exits.
    if (run.state === 'stopping' || TERMINAL_STATES.has(run.state)) return;
    if (agent.runtime && ACTIVE_STATES.has(run.state)) {
      await this.#journal.transition(agent, run, 'stopping', {
        error: error.message,
        activity: 'stopping after failure',
      });
      try {
        await this.#closeRuntime(agent);
      } catch (cleanupError) {
        run.error = `${error.message}; cleanup failed: ${cleanupError.message}`;
        run.activity = 'cleanup failed; stop again to retry';
        await this.#journal.publish(agent, run);
        return;
      }
    }
    if (!run.stopPromise) await this.#journal.terminal(agent, run, state, { error: error.message });
  }

  /** Admission, worker startup and the prompt shared by new agents and continuations; resolves with the accepted prompt. */
  /**
   * @param {any} agent
   * @param {any} run
   * @param {{ signal?: AbortSignal, prompt: string, activity: string, stoppedMessage: string }} launch
   */
  async #launch(agent, run, { signal, prompt, activity, stoppedMessage }) {
    await this.#journal.publish(agent, run);
    await this.#admit(agent, run, signal);
    assertNotAborted(signal);
    ({ promise: run.completion, resolve: run.completionResolve } = deferred());
    if (!agent.runtime) {
      run.startup = this.#createRuntime(agent);
      agent.runtime ??= await run.startup;
      delete run.startup;
    }
    this.#activity.attach(agent);
    assertNotAborted(signal);
    if (this.#closed || run.state !== 'starting') throw new Error(stoppedMessage);
    await this.#journal.transition(agent, run, 'running', { activity });
    const accepted = await agent.runtime.prompt(prompt);
    assertNotAborted(signal);
    run.runtimeRunId = accepted.runId;
    return accepted;
  }

  // Callers publish the accepted run synchronously after this, before any settlement can.
  #settleWhenDone(agent, run, accepted) {
    void accepted.result.then(
      result => this.#settle(agent, run, result),
      error => this.#settle(agent, run, { status: 'failed', errorMessage: error.message }),
    );
  }

  #newAgent(input) {
    assertAgentInput(input);
    if (this.#closed) throw new Error('Subagent session is closed');
    return this.#registry.add({ ...input, ownerSessionId: this.ownerSessionId, branchId: this.branchId });
  }

  /** @param {{ context?: string, signal?: AbortSignal, [field: string]: unknown }} [input] */
  async start({ context = '', signal, ...input } = {}) {
    const agent = this.#newAgent({ ...input, context });
    const run = newRun('awaiting admission', { instructions: [agent.task] });
    agent.runs.push(run);
    try {
      const accepted = await this.#launch(agent, run, {
        signal,
        prompt: `${agent.task}\n\nSelected context:\n${context}`,
        activity: 'working',
        stoppedMessage: 'Subagent launch was stopped during startup',
      });
      this.#settleWhenDone(agent, run, accepted);
      await this.#journal.publish(agent, run);
      return { agentId: agent.agentId, alias: agent.alias, runId: run.runId, state: run.state };
    } catch (error) {
      await this.#failRun(agent, run, error, signal?.aborted ? 'cancelled' : 'failed');
      throw error;
    }
  }

  async #settle(agent, run, result) {
    if (isSettled(run)) return;
    const text = result?.text ?? '';
    const stored = Boolean(this.#saveResult && text);
    try {
      if (stored) await this.#saveResult(agent, run, text);
    } catch (error) {
      if (isSettled(run)) return;
      await this.#journal.terminal(agent, run, 'failed', {
        error: `Subagent result could not be archived: ${error.message}`,
        activity: 'result archival failed',
      });
      return;
    }
    if (isSettled(run)) return;
    const { status, patch } = settledOutcome(run, result, stored);
    await this.#journal.terminal(agent, run, status, patch);
  }

  /** Adds an instruction to the running worker without starting a new run. */
  async #steer(agent, run, message) {
    if (run.state !== 'running') throw new Error(`Subagent ${agent.alias} cannot receive a message while ${run.state}`);
    await agent.runtime.steer(message);
    run.instructions.push(message);
    run.activity = 'received additional instruction';
    await this.#journal.publish(agent, run);
    return { agentId: agent.agentId, runId: run.runId, state: run.state, continued: false };
  }

  /** A continuation needs the previous transcript and exactly the capabilities authorized at launch. */
  #authorizeContinuation(agent, capabilities) {
    if (!agent.runtime && !agent.runs.some(candidate => candidate.sessionFile)) {
      throw new Error(`Subagent ${agent.alias} transcription is unavailable for continuation`);
    }
    if (!agent.capabilitySnapshot) return;
    if (
      !capabilities?.capabilitySnapshot ||
      JSON.stringify(agent.capabilitySnapshot) !== JSON.stringify(capabilities.capabilitySnapshot)
    ) {
      throw new Error(`Subagent ${agent.alias} capabilities no longer match the authorized snapshot`);
    }
    agent.privateCapabilities = capabilities.privateCapabilities;
  }

  /** @param {{ agentId?: string, message?: string, capabilities?: any }} [input] */
  async send({ agentId, message, capabilities } = {}) {
    if (typeof message !== 'string' || !message.trim()) throw new TypeError('message must be a non-empty string');
    const agent = this.assertCurrentBranch(agentId);
    const run = agent.runs.at(-1);
    if (run?.state === 'awaiting_confirmation') throw new Error(`Subagent ${agent.alias} is awaiting confirmation`);
    if (run && ACTIVE_STATES.has(run.state)) return this.#steer(agent, run, message);
    this.#authorizeContinuation(agent, capabilities);
    const continuation = newRun('awaiting continuation admission', {
      continuationOf: run?.runId,
      instructions: [message],
    });
    if (run) this.#activity.forget(run);
    agent.runs.push(continuation);
    try {
      const accepted = await this.#launch(agent, continuation, {
        prompt: `Follow-up on the previous delegated work:\n${message}`,
        activity: 'working on continuation',
        stoppedMessage: 'Subagent continuation was stopped during startup',
      });
      this.#settleWhenDone(agent, continuation, accepted);
      return { agentId, runId: continuation.runId, state: continuation.state, continued: true };
    } catch (error) {
      await this.#failRun(agent, continuation, error, this.#closed ? 'cancelled' : 'failed');
      throw error;
    }
  }

  /** @param {{ agentId?: string, runId?: string, cursor?: number, maxBytes?: number }} [input] */
  async result({ agentId, runId, cursor, maxBytes } = {}) {
    const agent = this.#registry.get(agentId);
    const run = agent.runs.find(candidate => candidate.runId === runId);
    if (!run) throw new Error(`Unknown run ${runId} for subagent ${agent.alias}`);
    const value = publicRun(run);
    // Instruction history belongs to agent details, not each model-facing result page.
    delete value.instructions;
    if (!this.#readResult || !value.resultStored) return value;
    const page = await this.#readResult(agent, run, { cursor, maxBytes });
    delete value.result;
    return { ...value, ...page };
  }

  /** @param {{ agentId?: string, cursor?: number, maxBytes?: number }} [input] */
  async transcript({ agentId, cursor = 0, maxBytes = 24 * 1024 } = {}) {
    const agent = this.#registry.get(agentId);
    if (!this.#readTranscript) throw new Error('Subagent transcript is unavailable');
    const sessionFile = agent.runs.findLast(run => run.sessionFile)?.sessionFile;
    return this.#readTranscript(publicAgent(agent), { sessionFile, cursor, maxBytes });
  }

  /** @param {{ agentIds?: string[], runIds?: string[], mode?: string, timeoutMs?: number, signal?: AbortSignal }} [input] */
  async wait({ agentIds, runIds, mode = 'all', timeoutMs = 30_000, signal } = {}) {
    const selected = this.#registry.selectRuns(agentIds, runIds);
    if (!['all', 'any'].includes(mode) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
      throw new TypeError('Invalid wait mode or timeout');
    if (signal?.aborted) throw new Error('Subagent wait was cancelled');
    const active = selected.filter(run => ACTIVE_STATES.has(run.state) && run.completion);
    const anySettled = mode === 'any' && selected.some(run => TERMINAL_STATES.has(run.state));
    if (!anySettled && active.length) await awaitRuns(active, { mode, timeoutMs, signal });
    return selected.map(run => compactRun(run));
  }

  /** @param {{ agentId?: string }} [input] */
  stop({ agentId } = {}) {
    const agent = this.#registry.get(agentId);
    const run = agent.runs.at(-1);
    if (run?.stopPromise) return run.stopPromise;
    if (!run || TERMINAL_STATES.has(run.state)) return Promise.resolve(compactRun(run));
    const operation = this.#stopRun(agent, run);
    run.stopPromise = operation;
    const clear = () => {
      if (run.stopPromise === operation) delete run.stopPromise;
    };
    void operation.then(clear, clear);
    return operation;
  }

  async #stopRun(agent, run) {
    if (run.state === 'awaiting_confirmation') {
      this.#confirmations.cancel(run);
      await this.#journal.terminal(agent, run, 'cancelled', { error: 'Subagent launch cancelled' });
      return compactRun(run);
    }
    await this.#journal.transition(agent, run, 'stopping', { activity: 'stopping' }).catch(() => {});
    try {
      await run.startup?.catch(() => {});
      delete run.startup;
      if (TERMINAL_STATES.has(run.state)) return compactRun(run);
      await this.#closeRuntime(agent);
      await this.#journal.terminal(agent, run, 'cancelled', {
        error: 'Subagent stopped by user',
        activity: 'cancelled',
      });
      return compactRun(run);
    } catch (error) {
      if (run.state === 'stopping' && agent.runtime) {
        run.error = `Subagent cleanup failed: ${error.message}`;
        run.activity = 'cleanup failed; stop again to retry';
        await this.#journal.publish(agent, run);
      } else if (!TERMINAL_STATES.has(run.state)) {
        await this.#journal.terminal(agent, run, 'failed', { error: error.message });
      }
      throw error;
    }
  }

  async shutdown() {
    this.#closed = true;
    const outcomes = await Promise.allSettled(
      this.#registry.all().map(async agent => {
        try {
          await this.stop({ agentId: agent.agentId });
        } catch {
          // Retry once after a failed stop, without losing the runtime on failure.
        }
        await this.#closeRuntime(agent);
        const run = agent.runs.at(-1);
        if (run?.state === 'stopping') {
          await this.#journal.terminal(agent, run, 'cancelled', {
            error: 'Subagent stopped during shutdown',
            activity: 'cancelled',
          });
        }
      }),
    );
    const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
    if (failures.length)
      throw new AggregateError(
        failures,
        `Subagent shutdown failed: ${failures.map(error => error.message).join('; ')}`,
      );
  }
}
