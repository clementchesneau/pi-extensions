// Run states of a subagent and the run views shared by the manager.

/** States in which a run holds a concurrency slot and possibly a worker. */
export const ACTIVE_STATES = new Set(['starting', 'running', 'stopping']);
/** States of a run that has not ended yet, including one still awaiting confirmation. */
export const UNFINISHED_STATES = new Set(['awaiting_confirmation', ...ACTIVE_STATES]);
export const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
export const TRANSITIONS = {
  awaiting_confirmation: new Set(['starting', 'cancelled', 'failed']),
  starting: new Set(['running', 'stopping', 'failed', 'cancelled']),
  running: new Set(['stopping', 'completed', 'failed', 'cancelled']),
  stopping: new Set(['cancelled', 'failed']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export const now = () => new Date().toISOString();

export function deferred() {
  let resolve;
  const promise = new Promise(res => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Throws unless `run` may move to `state`. */
export function assertTransition(run, state) {
  if (!TRANSITIONS[run.state]?.has(state)) throw new Error(`Illegal subagent run transition ${run.state} → ${state}`);
}

/** Whether a stop or an earlier outcome already decided how `run` ends. */
export const isSettled = run => run.state === 'stopping' || TERMINAL_STATES.has(run.state);

/** Serializable copy of a run, without its live handles. */
export function publicRun(run) {
  const { runtime, startup, stopPromise, completion, completionResolve, ...value } = run;
  return structuredClone(value);
}

export function compactRun(run) {
  if (!run) return undefined;
  const { runId, state, startedAt, finishedAt, activity, error, usage } = run;
  return {
    runId,
    state,
    startedAt,
    finishedAt,
    activity,
    error: typeof error === 'string' ? error.slice(0, 2_000) : error,
    usage,
  };
}

/** Serializable copy of an agent and its runs, without live handles. */
export function publicAgent(agent) {
  return {
    agentId: agent.agentId,
    alias: agent.alias,
    ownerSessionId: agent.ownerSessionId,
    branchId: agent.branchId,
    title: agent.title,
    task: agent.task,
    context: agent.context,
    capabilitySnapshot: agent.capabilitySnapshot,
    model: agent.model,
    thinkingLevel: agent.thinkingLevel,
    tools: agent.tools,
    selectionSource: agent.selectionSource,
    sequence: agent.sequence,
    runs: agent.runs.map(run => publicRun(run)),
    run: agent.runs.at(-1) ? publicRun(agent.runs.at(-1)) : undefined,
  };
}

export function compactAgent(agent) {
  return {
    agentId: agent.agentId,
    alias: agent.alias,
    branchId: agent.branchId,
    title: agent.title,
    runs: agent.runs.map(run => compactRun(run)),
    run: compactRun(agent.runs.at(-1)),
  };
}

// The worker's final figures win; the run keeps what it streamed when they are missing.
const settledTelemetry = (run, result) => ({
  sessionFile: result?.sessionStats?.sessionFile,
  usage: result?.usage ?? run.usage,
  contextUsage: result?.contextUsage ?? run.contextUsage,
  runtimeRunId: result?.runId ?? run.runtimeRunId,
});

const settledStatus = result =>
  result?.status === 'completed' ? 'completed' : result?.status === 'aborted' ? 'cancelled' : 'failed';

/** Terminal state and run fields recorded from a worker result; `stored` when its text was archived. */
export function settledOutcome(run, result, stored) {
  const status = settledStatus(result);
  const text = result?.text ?? '';
  return {
    status,
    patch: {
      ...(stored ? { resultStored: true } : { result: text }),
      ...(status === 'completed' && text ? { resultPreview: text.slice(0, 240) } : {}),
      error: result?.errorMessage,
      ...settledTelemetry(run, result),
      activity: status === 'completed' ? 'result available (unverified)' : status,
    },
  };
}

/**
 * Resolves once `runs` complete (`all`) or one completes (`any`); rejects on timeout or abort.
 * @param {any[]} runs runs with a `completion` promise
 * @param {{ mode: string, timeoutMs: number, signal?: AbortSignal }} options
 */
export async function awaitRuns(runs, { mode, timeoutMs, signal }) {
  const pending = runs.map(run => run.completion.catch(error => ({ status: 'failed', errorMessage: error.message })));
  const completed = mode === 'all' ? Promise.all(pending) : Promise.race(pending);
  let timer;
  let abortListener;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Subagent wait timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  const aborted = signal
    ? new Promise((_, reject) => {
        abortListener = () => reject(new Error('Subagent wait was cancelled'));
        signal.addEventListener('abort', abortListener, { once: true });
      })
    : undefined;
  try {
    await Promise.race([completed, timeout, ...(aborted ? [aborted] : [])]);
  } finally {
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

/** Worker events that update the streamed message or tool output of a run. */
export const STREAM_EVENTS = new Set([
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
]);

/** Persisted activity line of a worker event, when it marks progress worth recording. */
export function activityLabel(data) {
  const tool = typeof data?.toolName === 'string' ? data.toolName.slice(0, 200) : 'unknown tool';
  if (data?.type === 'tool_execution_start') return `tool: ${tool}`;
  if (data?.type === 'tool_execution_end') return `tool finished: ${tool}`;
  if (data?.type === 'message_end' && data.message?.role === 'assistant') return 'assistant message';
  return undefined;
}
