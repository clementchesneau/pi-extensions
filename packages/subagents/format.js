import { truncateToWidth } from '@earendil-works/pi-tui';
import { singleLineText } from '@clement_chsn/pi-shared/terminal-text';
import { UNFINISHED_STATES } from './run-state.js';

const STATES = {
  awaiting_confirmation: 'awaiting confirmation',
  starting: 'starting',
  running: 'in progress',
  stopping: 'stopping',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};
export const stateLabel = state => STATES[state] ?? 'unknown';

function durationText(milliseconds) {
  if (!Number.isFinite(milliseconds)) return 'duration unavailable';
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

export function duration(run, now = Date.now()) {
  const start = Date.parse(run?.startedAt);
  const end = run?.finishedAt ? Date.parse(run.finishedAt) : now;
  return durationText(end - start);
}

export function cumulativeDuration(agent, now = Date.now()) {
  const runs = agent.runs?.length ? agent.runs : agent.run ? [agent.run] : [];
  if (!runs.length) return 'duration unavailable';
  const elapsed = runs.map(run => {
    const end = run.finishedAt ? Date.parse(run.finishedAt) : UNFINISHED_STATES.has(run.state) ? now : NaN;
    return Math.max(0, end - Date.parse(run.startedAt));
  });
  return durationText(elapsed.reduce((sum, value) => sum + value, 0));
}

const costText = cost => (cost > 0 && cost < 0.00000001 ? '<0.00000001' : String(Number(cost.toFixed(8))));
const tokenNumber = new Intl.NumberFormat('en-US');
const costNumber = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 });
const compactUsage = (tokens, cost) =>
  `${Number.isFinite(tokens) ? `${tokenNumber.format(tokens)} tokens` : 'tokens unavailable'} · ${Number.isFinite(cost) ? `$${costNumber.format(cost)}` : 'cost unavailable'}`;

export function statusLine(agent, now = Date.now()) {
  const run = agent.run ?? agent.runs?.at(-1);
  const state = stateLabel(run?.state);
  return `${singleLineText(agent.alias)} ${state} ${duration(run, now)} · ${singleLineText(agent.title)}${UNFINISHED_STATES.has(run?.state) && run?.activity ? ` · ${singleLineText(run.activity)}` : ''}`;
}

export function formatStatus(agents, { maxConcurrent = 4, now = Date.now() } = {}, width = 80, theme) {
  if (!agents.some(agent => UNFINISHED_STATES.has(agent.run?.state)) || width <= 0) return [];
  const sorted = agents
    .filter(a => UNFINISHED_STATES.has(a.run?.state))
    .sort((a, b) => Date.parse(b.run?.startedAt ?? 0) - Date.parse(a.run?.startedAt ?? 0));
  const displayed = sorted.slice(0, 6);
  const header = `Subagents ${sorted.length}/${maxConcurrent} · /subagents${sorted.length > displayed.length ? ` · ${sorted.length - displayed.length} hidden` : ''}`;
  const color = (name, text) => theme?.fg?.(name, text) ?? text;
  return [
    truncateToWidth(color('accent', header), width),
    ...displayed.map(a =>
      truncateToWidth(color(UNFINISHED_STATES.has(a.run?.state) ? 'warning' : 'muted', statusLine(a, now)), width),
    ),
  ];
}

export function usageSummary(agent) {
  const runs = agent.runs ?? [];
  const latest = agent.run ?? runs.at(-1);
  return `Latest run: ${usageText(latest?.usage)}; ${cumulativeUsage(agent)}`;
}

export function cumulativeUsage(agent, { compact = false } = {}) {
  const runs = agent.runs ?? (agent.run ? [agent.run] : []);
  const final = runs.filter(run => ['completed', 'failed', 'cancelled'].includes(run.state));
  const active = runs.filter(run => UNFINISHED_STATES.has(run.state) && run.usage);
  const included = [...final, ...active];
  if (!included.length) return 'total: unavailable';
  const values = included.map(run => run.usage);
  const tokens = values.map(
    value =>
      value?.totalTokens ??
      value?.total ??
      (Number.isFinite(value?.input) && Number.isFinite(value?.output) ? value.input + value.output : undefined),
  );
  const costs = values.map(value => value?.cost?.total);
  if (compact)
    return `Total · ${compactUsage(
      tokens.every(Number.isFinite) ? tokens.reduce((a, b) => a + b, 0) : undefined,
      costs.every(Number.isFinite) ? costs.reduce((a, b) => a + b, 0) : undefined,
    )} · ${final.length} completed run(s)${active.length ? ' · live' : ''}`;
  return `Total for ${final.length} completed run(s): ${tokens.every(Number.isFinite) ? `${tokens.reduce((a, b) => a + b, 0)} tokens` : 'tokens unavailable'} ; ${costs.every(Number.isFinite) ? `${costText(costs.reduce((a, b) => a + b, 0))} USD` : 'cost unavailable'}${active.length ? ' (including live run)' : ''}`;
}

export function usageBreakdownText(usage) {
  const count = value => (Number.isFinite(value) ? tokenNumber.format(value) : 'unavailable');
  return `Input ${count(usage?.input)} · Output ${count(usage?.output)} · Cache read ${count(usage?.cacheRead)} · Cache write ${count(usage?.cacheWrite)}`;
}

export function contextUsageText(usage) {
  if (!usage || !Number.isFinite(usage.contextWindow)) return 'Context · unavailable';
  const limit = tokenNumber.format(usage.contextWindow);
  if (!Number.isFinite(usage.tokens)) return `Context · unavailable / ${limit} tokens`;
  const percent = Number.isFinite(usage.percent) ? usage.percent : (usage.tokens / usage.contextWindow) * 100;
  return `Context · ~${tokenNumber.format(usage.tokens)} / ${limit} tokens · ${Number(percent.toFixed(1))}% (estimated)`;
}

export function usageText(usage, { compact = false } = {}) {
  if (!usage) return 'Usage unavailable';
  const tokens = usage.totalTokens ?? usage.total ?? usage.input + usage.output;
  const cost = usage.cost?.total;
  if (compact) return compactUsage(tokens, cost);
  return `Reported usage: ${Number.isFinite(tokens) ? `${tokens} tokens` : 'tokens unavailable'} ; ${Number.isFinite(cost) ? `${costText(cost)} USD` : 'cost unavailable'}`;
}
