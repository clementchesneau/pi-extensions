import { Type } from 'typebox';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { jsonToolResult } from '@clement_chsn/pi-shared/tool-result';

const LOW_PERCENT = 60;

const continuationMessage = errorMessage => ({
  customType: 'session-compaction:continuation-v1',
  display: false,
  content: errorMessage
    ? `Voluntary compaction failed: ${errorMessage}. Continue the original task without automatically retrying compaction.`
    : 'Voluntary native compaction completed. Continue the original task; consult the curated memory index and read only relevant notes.',
});

function phase({ compacting, percent, enabled, highPercent }) {
  if (compacting) return 'compacting';
  if (percent === null || enabled === null) return 'unknown';
  if (enabled && highPercent !== null && percent > highPercent) return 'automatic';
  return percent >= LOW_PERCENT ? 'available' : 'below';
}

/** Native compaction settings of the session; null fields when Pi cannot tell. */
function nativeThreshold(pi, ctx, usage) {
  try {
    const settings = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx?.model);
    const window = usage?.contextWindow ?? ctx?.model?.contextWindow;
    const highPercent =
      Number.isFinite(window) && window > 0 ? (100 * (window - settings.reserveTokens)) / window : null;
    return { enabled: settings.enabled, highPercent };
  } catch {
    // Invalid settings have no guessed native threshold. Pi reports its own settings error.
    return { enabled: null, highPercent: null };
  }
}

// Cancellation is a user/runtime decision, never an invitation to restart work.
// Text is only a fallback when no native terminal outcome was delivered.
const cancelled = (request, error) =>
  request.resumed ||
  request.aborted === true ||
  (request.aborted === undefined && error && /abort|cancel/i.test(error.message));

function budget(pi, state, ctx) {
  const usage = ctx?.getContextUsage();
  const percent = Number.isFinite(usage?.percent) ? usage.percent : null;
  const { enabled, highPercent } = nativeThreshold(pi, ctx, usage);
  return {
    percent,
    lowPercent: LOW_PERCENT,
    highPercent,
    phase: phase({ compacting: state.compacting, percent, enabled, highPercent }),
    enabled,
  };
}

function startCompaction({ pi, state, memory, publish }, request, ctx) {
  state.inFlight = request;
  state.compacting = true;
  publish(ctx);
  let completed = false;
  const finish = error => {
    const session = memory.active;
    if (completed || session !== request.session || session.generation !== request.generation) return;
    completed = true;
    if (state.inFlight === request) state.inFlight = undefined;
    state.compacting = false;
    publish(ctx);
    if (cancelled(request, error)) return;
    pi.sendMessage(continuationMessage(error?.message), { triggerTurn: true, deliverAs: 'followUp' });
  };
  // This API is deliberately fire-and-forget: native compact() aborts and waits for
  // idle. Awaiting callbacks here would deadlock this very settlement boundary.
  // Tool results are finalized now; the boundary returns and releases idle first.
  try {
    ctx.compact({ onComplete: () => finish(), onError: finish });
  } catch (error) {
    finish(error);
  }
}

/** Records a native compaction outcome; a pending request it satisfies still owes its continuation. */
function recordNativeOutcome(state, name, event) {
  // Native cancellation can retain an unrelated provider error as its message.
  // The explicit terminal outcome, not error text, is authoritative.
  if (name === 'session_compact_failed' && state.inFlight && typeof event.aborted === 'boolean')
    state.inFlight.aborted = event.aborted;
  // A native automatic/manual compaction can satisfy the request before its
  // settlement handler runs. terminate:true still owes a continuation: retain
  // that obligation rather than discarding the request or compacting twice.
  if (state.pending) {
    if (name === 'session_compact_failed' && event.aborted === true) state.pending = undefined;
    else
      state.pending.nativeOutcome = {
        errorMessage: name === 'session_compact' ? null : (event.errorMessage ?? 'Native compaction failed'),
      };
  }
  state.compacting = false;
}

/** At settlement, runs the pending request, or only resumes when native compaction already satisfied it. */
function settle(context, event, ctx) {
  const { state, memory } = context;
  const request = state.pending;
  state.pending = undefined;
  const session = memory.active;
  if (!request || request.session !== session || request.generation !== session.generation) return;
  if (event.outcome !== 'completed') return;
  if (request.nativeOutcome) {
    return {
      entries: [{ type: 'custom_message', ...continuationMessage(request.nativeOutcome.errorMessage) }],
      continue: true,
    };
  }
  startCompaction(context, request, ctx);
}

function requestCompaction({ state, memory, publish }, reason, ctx) {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 240)
    throw new Error('Compaction reason must be 1–240 characters');
  if (ctx.mode === 'print' || ctx.mode === 'json')
    throw new Error(
      'Voluntary compaction is unavailable in print/JSON one-shot mode; native automatic compaction remains unchanged',
    );
  const usage = publish(ctx);
  if (usage.percent === null || usage.percent < LOW_PERCENT)
    throw new Error('Voluntary compaction requires known context usage of at least 60%');
  if (state.compacting || state.pending || state.inFlight) throw new Error('Compaction already requested or running');
  const session = memory.current();
  state.pending = { session, generation: session.generation, reason: reason.trim() };
  return state.pending.reason;
}

function registerEvents(pi, context) {
  const { state, publish } = context;
  pi.events?.on?.('session-compaction:request-state', () => publish());
  pi.on('turn_start', () => {
    // Queued user work or another native continuation already restarted the model.
    // The obligation created by terminate:true is consumed: never restore the old
    // task at a later settlement or from a delayed manual-compaction callback.
    state.pending = undefined;
    if (state.inFlight) state.inFlight.resumed = true;
  });
  for (const name of ['message_end', 'model_select', 'agent_end', 'agent_settled'])
    pi.on(name, (_event, ctx) => {
      publish(ctx);
    });
  pi.on('session_before_compact', (_event, ctx) => {
    state.compacting = true;
    publish(ctx);
  });
  for (const name of ['session_compact', 'session_compact_failed'])
    pi.on(name, (event, ctx) => {
      recordNativeOutcome(state, name, event);
      publish(ctx);
    });
  pi.on('agent_before_settle', (event, ctx) => settle(context, event, ctx));
}

/**
 * Compaction the agent requests from 60% context. The request ends the tool batch; Pi's native
 * compaction then runs at settlement and a follow-up message resumes the original task.
 * `pending` is a request awaiting settlement, `inFlight` the compaction it started.
 */
export function createVoluntaryCompaction(pi, memory) {
  const state = { lastContext: undefined, compacting: false, pending: undefined, inFlight: undefined };
  const publish = (ctx = state.lastContext) => {
    if (ctx) state.lastContext = ctx;
    const value = budget(pi, state, ctx);
    pi.events?.emit?.('session-compaction:state', value);
    return value;
  };
  const context = { pi, state, memory, publish };
  return {
    register: () => registerEvents(pi, context),
    publish,
    request: (reason, ctx) => requestCompaction(context, reason, ctx),
    get pending() {
      return state.pending !== undefined;
    },
    /** A branch change or shutdown drops any request; `forget` also drops the last context. */
    reset({ forget = false } = {}) {
      state.pending = undefined;
      state.inFlight = undefined;
      state.compacting = false;
      if (forget) state.lastContext = undefined;
    },
  };
}

/** Tools to request a voluntary compaction and to inspect the budget and memory index. */
export function createCompactionTools(compaction, memory) {
  return [
    {
      name: 'session_compact',
      label: 'Compact at a useful boundary',
      exposure: 'model-only',
      executionMode: 'sequential',
      promptSnippet: 'Request native compaction at a useful completed-work boundary from 60% context.',
      promptGuidelines: [
        'From 60% context, consider compaction after a completed investigation, milestone or topic change, not in the middle of an unresolved tool sequence. First update curated factual memory. Do not compact merely because it is available or immediately retry a failed request.',
      ],
      description:
        'Request voluntary Pi-native compaction with a short reason. Available at context usage >=60%, even if automatic compaction is disabled. Ends the current tool batch, defers compaction until its results are persisted and resumes after the native summary. Never changes native thresholds or replaces the native summary. Use as the only call in its batch. Voluntary compaction is supported in TUI/RPC, not print/JSON one-shot mode because its host exits at settlement. Native automatic compaction remains unchanged in every mode.',
      parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 240 }) }),
      execute: async (_id, { reason }, _signal, _update, ctx) => ({
        ...jsonToolResult({
          requested: true,
          reason: compaction.request(reason, ctx),
          message: 'Native compaction scheduled at settlement; maintain memory before this call.',
        }),
        terminate: true,
      }),
    },
    {
      name: 'session_compaction_status',
      label: 'Session compaction status',
      promptSnippet: 'Inspect context usage, native compaction threshold and curated memory index.',
      description:
        'Return context percentage, voluntary availability from 60%, unchanged effective native automatic threshold, and a small index of temporary branch-local memory. Does not read memory contents.',
      parameters: Type.Object({}),
      execute: async (_id, _params, _signal, _update, ctx) =>
        jsonToolResult({
          ...compaction.publish(ctx),
          memory: memory.active?.notes ?? [],
          unavailableNotes: memory.active?.unavailableNotes ?? 0,
          pending: compaction.pending,
        }),
    },
  ];
}
