import { truncateToWidth } from '@earendil-works/pi-tui';
import { formatDuration } from './format.js';

export const TIMER_ENTRY_TYPE = 'graphite-ui-timing';
const TIMER_WIDGET_KEY = 'graphite-ui-timer';

function timingData(timing) {
  return {
    durationMs: timing.durationMs,
    ...(Number.isFinite(timing.endedAt) ? { endedAt: timing.endedAt } : {}),
    ...(timing.anchorMessageId ? { anchorMessageId: timing.anchorMessageId } : {}),
    ...(timing.timingId ? { timingId: timing.timingId } : {}),
  };
}

function latestAssistantMessageId(ctx) {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === 'message' && entry.message?.role === 'assistant') return entry.id;
  }
  return undefined;
}

/** The persisted run in `entry` when it belongs to `branch`, directly or through its anchor message. */
function branchTiming(entry, branch, branchIds) {
  if (entry?.type !== 'custom' || entry.customType !== TIMER_ENTRY_TYPE) return undefined;
  const durationMs = entry.data?.durationMs;
  if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;
  const anchorMessageId = entry.data?.anchorMessageId;
  const onBranch = branch.includes(entry) || Boolean(entry.id && branchIds.has(entry.id));
  const belongsToBranch = typeof anchorMessageId === 'string' ? branchIds.has(anchorMessageId) : onBranch;
  if (!belongsToBranch) return undefined;
  const timingId = entry.data?.timingId || entry.id;
  return { durationMs, endedAt: entry.data?.endedAt, anchorMessageId, timingId, onBranch };
}

/** Completed runs of `branch` found in `entries`, once per timing ID. */
function branchTimings(entries, branch) {
  const branchIds = new Set(branch.map(entry => entry?.id).filter(Boolean));
  const timings = new Map();
  for (const entry of entries) {
    const timing = branchTiming(entry, branch, branchIds);
    if (!timing) continue;
    const key = timing.timingId || entry;
    const existing = timings.get(key);
    if (existing) existing.onBranch ||= timing.onBranch;
    else timings.set(key, timing);
  }
  return [...timings.values()];
}

function clockText({ activeMs, completedMs, runCount, live, compactionCount }) {
  const totalText = formatDuration(completedMs + activeMs);
  const showTotal = runCount >= 2;
  const compactions = compactionCount > 0 ? `${showTotal || live ? ' · ' : ''}${compactionCount} comp` : '';
  const current = live ? `⏱ ${formatDuration(activeMs)}` : showTotal ? `Total ${totalText}` : '';
  return `${current}${live && showTotal ? ` · ${totalText}` : ''}${compactions}`;
}

/** Transcript line of a persisted run duration. */
export function renderTimingEntry(entry, _options, theme) {
  const durationMs = entry.data?.durationMs;
  if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;
  return {
    render(width) {
      const endedAt = new Date(entry.data?.endedAt);
      const endTime =
        Number.isFinite(entry.data?.endedAt) && Number.isFinite(endedAt.getTime())
          ? ` · ${[endedAt.getHours(), endedAt.getMinutes(), endedAt.getSeconds()].map(value => String(value).padStart(2, '0')).join(':')}`
          : '';
      const label = theme.fg('dim', ` ⏱ ${formatDuration(durationMs)} · run duration${endTime}`);
      return [truncateToWidth(label, Math.max(0, width), '')];
    },
    invalidate() {},
  };
}

/**
 * Where the clock appears: the shared activity bar when one has announced itself, otherwise a
 * widget of its own. A bar announced while the widget is shown takes over from it.
 */
function createClockDisplay({ indicator, text, live, scheduleInterval, cancelInterval }) {
  let interval;
  let shownCtx;
  let inBar = false;
  let requestRender;

  function stopRefresh() {
    if (interval === undefined) return;
    cancelInterval(interval);
    interval = undefined;
  }

  function startRefresh() {
    stopRefresh();
    if (!live() || !shownCtx) return;
    interval = scheduleInterval(() => requestRender?.(), 1_000);
  }

  function showWidget(ctx) {
    ctx.ui.setWidget(TIMER_WIDGET_KEY, (tui, theme) => {
      const render = () => tui.requestRender();
      requestRender = render;
      return {
        dispose() {
          // A replaced or hidden display no longer owns the refresh.
          if (requestRender !== render) return;
          requestRender = undefined;
          stopRefresh();
        },
        invalidate() {},
        render(width) {
          const line = text(ctx);
          if (!line) return [];
          return [truncateToWidth(theme.fg(live() ? 'accent' : 'dim', ` ${line}`), Math.max(0, width), '')];
        },
      };
    });
  }

  function show(ctx) {
    shownCtx = ctx;
    inBar = indicator.available;
    if (inBar) {
      requestRender = () => indicator.timer({ text: text(ctx), active: live() });
      requestRender();
    } else showWidget(ctx);
    startRefresh();
  }

  function hide() {
    if (!shownCtx) return;
    if (inBar) indicator.timer({ text: '', active: false });
    else shownCtx.ui.setWidget(TIMER_WIDGET_KEY, undefined);
    shownCtx = undefined;
    requestRender = undefined;
    stopRefresh();
  }

  indicator.onReady(() => {
    const ctx = shownCtx;
    if (!ctx) return;
    hide();
    show(ctx);
  });

  return { show, hide, startRefresh, stopRefresh, render: () => requestRender?.() };
}

/** Run durations of the current branch: the live clock and completed runs persisted as custom entries. */
export function createRunTimer(pi, { indicator, now, scheduleInterval, cancelInterval }) {
  let startedAt;
  let timingId;
  let completedMs = 0;
  let completedCount = 0;
  const live = () => startedAt !== undefined;
  const text = ctx =>
    clockText({
      activeMs: live() ? Math.max(0, now() - startedAt) : 0,
      completedMs,
      runCount: completedCount + (live() ? 1 : 0),
      live: live(),
      compactionCount: (ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch()).filter(
        entry => entry?.type === 'compaction',
      ).length,
    });
  const display = createClockDisplay({ indicator, text, live, scheduleInterval, cancelInterval });

  /** Recomputes completed runs on `branch`; returns those found only outside it. */
  function restore(ctx, additionalEntries = [], branch = ctx.sessionManager.getBranch()) {
    const entries = [...(ctx.sessionManager.getEntries?.() ?? branch), ...additionalEntries];
    const timings = branchTimings(entries, branch);
    completedCount = timings.length;
    completedMs = timings.reduce((total, timing) => total + timing.durationMs, 0);
    return timings.filter(timing => !timing.onBranch);
  }

  return {
    show: display.show,
    hide: display.hide,
    render: display.render,

    /** A new session starts with no live run. */
    reset() {
      startedAt = undefined;
      timingId = undefined;
    },

    /** Restores completed runs, persisting those that only exist in `previousEntries` (a fork source). */
    restoreBranch(ctx, previousEntries = []) {
      for (const timing of restore(ctx, previousEntries)) pi.appendEntry(TIMER_ENTRY_TYPE, timingData(timing));
    },

    /** Entries an in-memory fork towards `targetBranch` would lose; the current branch stays restored. */
    forkEntries(ctx, targetBranch) {
      const missing = restore(ctx, [], targetBranch);
      restore(ctx);
      return missing.map((timing, index) => ({
        type: 'custom',
        id: `in-memory-fork-timing-${index}`,
        customType: TIMER_ENTRY_TYPE,
        data: timingData(timing),
      }));
    },

    start(ctx) {
      if (live()) return;
      startedAt = now();
      const entryCount = ctx.sessionManager.getEntries?.().length ?? 0;
      timingId = `${ctx.sessionManager.getSessionId()}:${startedAt}:${entryCount}`;
      display.startRefresh();
      display.render();
    },

    /** Ends the live run and persists its duration; returns whether a run was live. */
    settle(ctx) {
      if (!live()) return false;
      const endedAt = now();
      const durationMs = Math.max(0, endedAt - startedAt);
      const id = timingId;
      startedAt = undefined;
      timingId = undefined;
      completedMs += durationMs;
      completedCount += 1;
      display.stopRefresh();
      const anchorMessageId = latestAssistantMessageId(ctx);
      pi.appendEntry(TIMER_ENTRY_TYPE, timingData({ durationMs, endedAt, anchorMessageId, timingId: id }));
      display.render();
      return true;
    },
  };
}
