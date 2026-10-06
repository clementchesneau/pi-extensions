// Accounting of one worker run: assistant usage confirmed by message_end, session totals
// sampled from get_session_stats, and the result reported once the run settles.
import { RunUsage } from './live-state.js';

/** RPC events after which the session totals may have changed. */
export const TELEMETRY_EVENTS = new Set([
  'message_end',
  'tool_execution_end',
  'compaction_start',
  'compaction_end',
  'auto_compaction_start',
  'auto_compaction_end',
]);

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
}

function sessionUsage(stats) {
  if (!stats?.tokens || !Number.isFinite(stats.tokens.total) || !Number.isFinite(stats.cost)) return undefined;
  return {
    input: stats.tokens.input ?? 0,
    output: stats.tokens.output ?? 0,
    cacheRead: stats.tokens.cacheRead ?? 0,
    cacheWrite: stats.tokens.cacheWrite ?? 0,
    totalTokens: stats.tokens.total,
    cost: { total: stats.cost },
  };
}

function combineUsage(left, right, sign = 1) {
  const usage = emptyUsage();
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
    usage[key] = Math.max(0, (left?.[key] ?? 0) + sign * (right?.[key] ?? 0));
  }
  usage.cost.total = Math.max(0, (left?.cost?.total ?? 0) + sign * (right?.cost?.total ?? 0));
  return usage;
}

function assistantText(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return undefined;
  return message.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
}

function resultStatus(message) {
  if (!message) return 'no_output';
  if (message.stopReason === 'length') return 'incomplete';
  if (message.stopReason === 'aborted') return 'aborted';
  if (message.stopReason === 'error' || message.errorMessage) return 'failed';
  return assistantText(message) ? 'completed' : 'no_output';
}

export function createRun(runId, completion) {
  const run = {
    runId,
    completion,
    lastAssistant: undefined,
    assistantUsage: emptyUsage(),
    usageState: new RunUsage(),
  };
  run.usageState.confirmed = run.assistantUsage;
  run.assistantCount = 0;
  run.assistantUsageHistory = new Map([[0, run.assistantUsage]]);
  return run;
}

/** Confirms the usage of an assistant message completed during `run`. */
export function recordAssistant(run, message) {
  run.lastAssistant = message;
  run.assistantUsage = combineUsage(run.assistantUsage, message.usage);
  run.usageState.confirmed = run.assistantUsage;
  run.assistantUsageHistory.set(++run.assistantCount, run.assistantUsage);
}

function sampleSessionUsage(run, stats, cumulative) {
  run.sessionStats = stats;
  run.sessionUsage = cumulative;
  if (stats.contextUsage !== undefined) run.contextUsage = stats.contextUsage;
  if (!run.baseline) return run.assistantCount;
  // Pi's snapshot reports how many assistants are archived. A response
  // can be delayed past another message_end (even within one JSONL chunk),
  // so subtract that prefix, not the latest confirmation at reception.
  const includedCount =
    Number.isInteger(stats.assistantMessages) && Number.isInteger(run.baselineAssistantCount)
      ? stats.assistantMessages - run.baselineAssistantCount
      : undefined;
  // Without a matching count, use the latest assistant lower bound rather
  // than guessing that the snapshot excludes messages completed in flight.
  const included = run.assistantUsageHistory.get(includedCount) ?? run.assistantUsage;
  run.usageState.sample(combineUsage(cumulative, run.baseline, -1), included);
  return includedCount ?? run.assistantCount;
}

/**
 * Folds a get_session_stats response (`{error}` when it failed) into `run`; the first one
 * of a run is its `baseline`. Returns the telemetry to publish.
 */
export function applySessionStats(run, stats, baseline) {
  const cumulative = sessionUsage(stats);
  if (baseline) {
    run.baseline = cumulative;
    run.baselineAssistantCount = stats.assistantMessages;
  }
  let retainFrom = run.assistantCount;
  if (cumulative) retainFrom = sampleSessionUsage(run, stats, cumulative);
  else if (!run.sessionStats) run.sessionStats = stats;
  // Without a usable baseline (or after a failure), older prefixes cannot
  // help a later read. Successful snapshots retain only their included prefix
  // and messages completed since then, never the entire run history.
  for (const count of run.assistantUsageHistory.keys()) if (count < retainFrom) run.assistantUsageHistory.delete(count);
  // The shared accumulator retains sampled extra costs and adds subsequent
  // assistant usage exactly once, including when a later stats read fails.
  run.usage = run.usageState.usage;
  return {
    usage: run.usage,
    contextUsage: run.contextUsage,
    sessionUsage: run.sessionUsage,
    updatedAt: Date.now(),
  };
}

export function settledResult(instanceId, run) {
  const message = run.lastAssistant;
  return {
    instanceId,
    runId: run.runId,
    status: resultStatus(message),
    text: assistantText(message) ?? '',
    stopReason: message?.stopReason,
    errorMessage: message?.errorMessage,
    usage: run.usage ?? run.assistantUsage,
    contextUsage: run.contextUsage,
    sessionStats: run.sessionStats,
  };
}
