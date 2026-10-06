// Run state changes: each one is checked, persisted with its agent and announced to listeners.
import { assertTransition, now, publicAgent, publicRun, TERMINAL_STATES } from './run-state.js';

export class RunJournal {
  #listeners = new Set();
  #persist;

  /** `persist(agent)` stores public agent metadata; it is optional. */
  constructor(persist) {
    this.#persist = persist;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async publish(agent, run, { persist = true } = {}) {
    const event = {
      agentId: agent.agentId,
      runId: run?.runId,
      sequence: ++agent.sequence,
      state: run?.state,
      agent: publicAgent(agent),
    };
    if (persist) await this.#persist?.(event.agent);
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  async transition(agent, run, state, patch = {}) {
    assertTransition(run, state);
    run.state = state;
    Object.assign(run, patch);
    if (TERMINAL_STATES.has(state)) {
      run.finishedAt ??= now();
      run.completionResolve?.(publicRun(run));
      delete run.completionResolve;
    }
    await this.publish(agent, run);
  }

  /** Ends `run` in `state`; a run whose final state cannot be archived ends as failed instead. */
  async terminal(agent, run, state, patch = {}) {
    assertTransition(run, state);
    run.state = state;
    Object.assign(run, patch);
    run.finishedAt ??= now();
    try {
      await this.#persist?.(publicAgent(agent));
    } catch (error) {
      run.state = 'failed';
      run.error = `Subagent state could not be archived: ${error.message}`;
      run.activity = 'state archival failed';
      delete run.result;
    }
    run.completionResolve?.(publicRun(run));
    delete run.completionResolve;
    await this.publish(agent, run, { persist: false });
    return publicRun(run);
  }
}
