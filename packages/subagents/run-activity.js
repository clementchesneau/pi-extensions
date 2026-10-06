// Live view of subagent runs, fed by their runtime events. Ephemeral display state:
// streamed text and tool output never reach persisted metadata.
import { LiveSubagentState } from './live-state.js';
import { activityLabel, now, STREAM_EVENTS } from './run-state.js';

const clone = value => structuredClone(value);

export class RunActivity {
  #states = new WeakMap();
  #listeners = new Set();
  #publish;
  #handleUiRequest;

  /** `publish(agent, run, options)` announces a run change; `handleUiRequest` serves child dialogs. */
  constructor({ publish, handleUiRequest }) {
    this.#publish = publish;
    this.#handleUiRequest = handleUiRequest;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #state(run) {
    let state = this.#states.get(run);
    if (!state) {
      state = new LiveSubagentState();
      this.#states.set(run, state);
    }
    return state;
  }

  snapshot(run) {
    return this.#state(run).snapshot(run.runId);
  }

  forget(run) {
    this.#states.delete(run);
  }

  /** Follows the events of the agent's current runtime, once per runtime. */
  attach(agent) {
    if (!agent.runtime?.subscribe || agent.runtimeUiAttached) return;
    const runtime = agent.runtime;
    agent.runtimeUiAttached = true;
    runtime.subscribe(event => {
      if (agent.runtime !== runtime) return;
      const request =
        event.type === 'rpc_event' && event.data?.type === 'extension_ui_request' ? event.data : undefined;
      if (request && this.#handleUiRequest) {
        void this.#handleUiRequest(agent, request, runtime).catch(() => {});
        return;
      }
      const run = agent.runs.at(-1);
      if (!run || run.state !== 'running' || (event.runId && run.runtimeRunId && event.runId !== run.runtimeRunId))
        return;
      if (event.type === 'telemetry') this.#recordTelemetry(agent, run, event.data);
      else if (event.type === 'rpc_event') this.#recordEvent(agent, run, event.data);
    });
  }

  #recordTelemetry(agent, run, data) {
    const state = this.#state(run);
    if (data?.usage !== undefined) state.sampled = clone(data.usage);
    run.usage = state.usage;
    if (data?.contextUsage !== undefined) run.contextUsage = clone(data.contextUsage);
    run.telemetryUpdatedAt = data?.updatedAt ?? now();
    void this.#publish(agent, run, { persist: false }).catch(() => {});
  }

  #recordEvent(agent, run, data) {
    if (STREAM_EVENTS.has(data?.type)) this.#stream(agent, run, data);
    const activity = activityLabel(data);
    if (!activity) return;
    run.activity = activity;
    run.activities ??= [];
    run.activities.push({ at: now(), activity });
    if (run.activities.length > 32) run.activities.shift();
    void this.#publish(agent, run).catch(() => {});
  }

  /** Feeds the live view; only usage changes reach persisted-state listeners. */
  #stream(agent, run, data) {
    const state = this.#state(run);
    const previousUsage = JSON.stringify(run.usage);
    state.update(data);
    const usage = state.usage;
    if (usage) run.usage = usage;
    for (const listener of this.#listeners) {
      try {
        listener({ agentId: agent.agentId, runId: run.runId, data });
      } catch {}
    }
    if (data.type === 'message_update' && JSON.stringify(run.usage) !== previousUsage) {
      void this.#publish(agent, run, { persist: false }).catch(() => {});
    }
  }
}
