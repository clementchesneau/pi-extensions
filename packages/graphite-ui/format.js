import { homedir } from 'node:os';
import { truncateToWidth, visibleWidth as tuiVisibleWidth } from '@earendil-works/pi-tui';
import { contextColor } from './compaction.js';

const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

export function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_PATTERN, '');
}

export function visibleWidth(value) {
  return tuiVisibleWidth(value);
}

function cleanLabel(value, fallback = '') {
  const cleaned = stripAnsi(value).replace(CONTROL_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

function truncate(value, width, ellipsis = '…') {
  return truncateToWidth(value, Math.max(0, width), ellipsis);
}

function joinWithin(parts, width) {
  let result = '';
  for (const part of parts.filter(Boolean)) {
    const candidate = result ? `${result} · ${part}` : part;
    if (visibleWidth(candidate) <= width) result = candidate;
  }
  return result;
}

function align(left, right, width) {
  if (width <= 0) return '';
  if (!right) return truncate(left, width);
  if (!left) {
    const text = truncate(right, width);
    return ' '.repeat(Math.max(0, width - visibleWidth(text))) + text;
  }

  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncate(right, width);
  const leftText = truncate(left, width - rightWidth - 1);
  if (!leftText) return ' '.repeat(width - rightWidth) + right;
  return leftText + ' '.repeat(width - visibleWidth(leftText) - rightWidth) + right;
}

function displayPath(cwd, home) {
  const path = cleanLabel(cwd, '.');
  const actualHome = cleanLabel(home || homedir());
  if (actualHome && (path === actualHome || path.startsWith(`${actualHome}/`))) {
    return `~${path.slice(actualHome.length)}`;
  }
  return path;
}

export function formatPercent(percent) {
  if (!Number.isFinite(percent)) return null;
  return `${Math.round(percent)}%`;
}

export function formatCount(value) {
  const count = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (count < 1_000) return `${Math.round(count)}`;
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}m`;
}

export function formatDuration(value) {
  const totalSeconds = Math.floor(Number.isFinite(value) ? Math.max(0, value) / 1_000 : 0);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  if (totalMinutes > 0) return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function formatCapacity(value) {
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${Number((value / 1_000_000).toFixed(1))}m`;
}

export function summarizeUsage(entries) {
  const totals = { inputTokens: 0, outputTokens: 0, cost: 0 };
  for (const entry of entries) {
    const message = entry?.type === 'message' ? entry.message : undefined;
    if (message?.role !== 'assistant' || !message.usage) continue;
    totals.inputTokens += message.usage.input || 0;
    totals.outputTokens += message.usage.output || 0;
    totals.cost += message.usage.cost?.total || 0;
  }
  return totals;
}

export function formatHeader({ width, project, cwd, style }) {
  const safeProject = cleanLabel(project, '.');
  const logo = ['█████████   ', '███▀▀▀███   ', '███   ███   ', '██████   ███', '███▀▀▀   ███', '███      ███'];
  const logoWidth = Math.max(...logo.map(visibleWidth));
  if (width >= logoWidth + 4) {
    const padding = ' '.repeat(Math.floor((width - logoWidth) / 2));
    const path = truncate(cwd ? displayPath(cwd) : safeProject, width);
    return [
      '',
      // The logo is deliberately white, independently of the theme accent.
      ...logo.map(line => `${padding}\u001b[38;2;255;255;255m${line}\u001b[39m`),
      '',
      ' '.repeat(Math.floor((width - visibleWidth(path)) / 2)) + style('accent', path),
      '',
    ];
  }
  const brand = '  π  PI';
  const separator = ' · ';
  const brandWidth = visibleWidth(brand);
  const title =
    width <= brandWidth
      ? style('accent', truncate(brand, width, ''))
      : style('accent', brand) +
        style('dim', truncate(separator, width - brandWidth, '')) +
        style('text', truncate(safeProject, Math.max(0, width - visibleWidth(brand + separator))));
  return [truncate(title, width, '')];
}

function modelLine({ safeWidth, cwd, home = '', provider, model, thinking, style }) {
  const modelText = cleanLabel(model, 'no model');
  const thinkingText = thinking && thinking !== 'off' ? cleanLabel(thinking) : '';

  const providerText = safeWidth >= 100 ? cleanLabel(provider) : '';
  const providerModel = providerText ? `${providerText}/${modelText}` : modelText;
  const modelLabel = style('accent', providerModel) + (thinkingText ? style('dim', ` · ${thinkingText}`) : '');
  return align(style('text', displayPath(cwd, home)), modelLabel, safeWidth);
}

/** Branch and changed-file count, within `budget` cells. */
function gitStatus(branch, changedFiles, budget) {
  const safeBranch = cleanLabel(branch);
  const git = safeBranch || (branch === null && changedFiles === null ? '' : branch === undefined ? '' : 'git ?');
  if (!git || budget < 4) return '';
  const changed = Number.isInteger(changedFiles) && changedFiles >= 0 ? `${changedFiles} changed` : '';
  return visibleWidth(git) > budget ? truncate(git, budget) : joinWithin([git, changed], budget);
}

function usageLine({
  safeWidth,
  branch,
  changedFiles,
  contextPercent,
  contextWindow,
  compactionState,
  inputTokens,
  outputTokens,
  cost,
  style,
}) {
  const percent = Number.isFinite(contextPercent) ? `${Math.round(contextPercent)}%` : '?%';
  const costText = `$${(Number.isFinite(cost) ? cost : 0).toFixed(3)}`;
  const contextWithCapacity = Number.isFinite(contextWindow) ? `${percent}/${formatCapacity(contextWindow)}` : percent;
  const expandedCore = `${contextWithCapacity} · ${costText}`;
  const core = visibleWidth(expandedCore) <= safeWidth ? expandedCore : `${percent} · ${costText}`;
  const tokens = `↑${formatCount(inputTokens)} ↓${formatCount(outputTokens)}`;
  const right = gitStatus(branch, changedFiles, Math.max(0, safeWidth - visibleWidth(core) - 1));
  const leftBudget = right ? safeWidth - visibleWidth(right) - 1 : safeWidth;
  const left = visibleWidth(core) > leftBudget ? truncate(core, leftBudget) : joinWithin([core, tokens], leftBudget);
  const coloredLeft = left
    ? style(contextColor(compactionState, contextPercent), left.slice(0, percent.length)) +
      style('muted', left.slice(percent.length))
    : '';
  return align(coloredLeft, right ? style('muted', right) : '', safeWidth);
}

export function formatFooter(footer) {
  const { width } = footer;
  const safeWidth = Math.max(0, Number.isFinite(width) ? Math.floor(width) : 0);
  return [truncate(modelLine({ ...footer, safeWidth }), safeWidth, ''), usageLine({ ...footer, safeWidth })];
}
