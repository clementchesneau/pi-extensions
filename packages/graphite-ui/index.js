import { SessionManager } from '@earendil-works/pi-coding-agent';
import { connectActivityIndicator } from '@clement_chsn/pi-shared/activity-indicator';
import { installChrome, restoreDefaults } from './chrome.js';
import { createFooter } from './footer.js';
import { readGitSnapshot } from './git.js';
import { createRunTimer, renderTimingEntry, TIMER_ENTRY_TYPE } from './run-timer.js';

const RENDER_EVENTS = ['model_select', 'thinking_level_select', 'turn_end', 'session_compact', 'session_tree'];
const GIT_ACTIVITY_EVENTS = ['input', 'tool_execution_end'];

// Pi reuses the cached extension factory across same-process session replacements.
// This bridges metadata that an in-memory fork cannot recover from a source file.
let pendingInMemoryForkEntries = [];

/** Entries of the session a fork starts from, for run durations it alone recorded. */
function forkSourceEntries(event) {
  if (event.reason !== 'fork') return [];
  if (!event.previousSessionFile) return pendingInMemoryForkEntries;
  try {
    return SessionManager.open(event.previousSessionFile).getEntries();
  } catch {
    // The fork remains usable if its source session was moved or deleted.
    return [];
  }
}

function registerTimerEvents(pi, timer, footer) {
  // Automatic pre-prompt compaction runs before before_agent_start.
  pi.on('session_before_compact', (event, ctx) => {
    if (event.reason !== 'manual') timer.start(ctx);
  });
  pi.on('before_agent_start', (_event, ctx) => {
    timer.start(ctx);
  });
  // Extension-triggered runs can skip before_agent_start.
  pi.on('agent_start', (_event, ctx) => {
    timer.start(ctx);
  });
  pi.on('agent_settled', (_event, ctx) => {
    if (timer.settle(ctx)) footer.render();
    void footer.refreshGit(ctx);
  });
  pi.on('session_before_fork', (event, ctx) => {
    if (ctx.sessionManager.isPersisted?.() !== false) return;
    const selectedEntry = ctx.sessionManager.getEntry(event.entryId);
    const targetLeafId = event.position === 'at' ? event.entryId : selectedEntry?.parentId;
    const targetBranch = targetLeafId ? ctx.sessionManager.getBranch(targetLeafId) : [];
    pendingInMemoryForkEntries = timer.forkEntries(ctx, targetBranch);
  });
}

function registerRenderEvents(pi, { timer, footer, isEnabled }) {
  pi.on('message_end', (event, ctx) => {
    if (!isEnabled() || !footer.isActive(ctx)) return;
    footer.render();
    if (event.message?.role === 'bashExecution') void footer.refreshGit(ctx);
  });
  for (const eventName of RENDER_EVENTS) {
    pi.on(eventName, (_event, ctx) => {
      if (eventName === 'session_tree') timer.restoreBranch(ctx);
      if (!isEnabled() || !footer.isActive(ctx)) return;
      footer.render();
      timer.render();
    });
  }
  for (const eventName of GIT_ACTIVITY_EVENTS) {
    pi.on(eventName, (_event, ctx) => {
      void footer.refreshGit(ctx);
    });
  }
}

async function refreshCommand(ctx, { footer, isEnabled }) {
  if (ctx.mode !== 'tui') {
    if (ctx.hasUI) ctx.ui.notify('Graphite UI: Git refresh is only available in TUI mode', 'warning');
    return;
  }
  if (!isEnabled() || !footer.isActive(ctx)) {
    ctx.ui.notify('Graphite UI is disabled', 'warning');
    return;
  }
  await footer.refreshGit(ctx);
  const error = footer.gitError();
  if (error) ctx.ui.notify(`Graphite UI: ${error}`, 'warning');
}

export default function graphiteUi(
  pi,
  {
    gitReader = readGitSnapshot,
    now = Date.now,
    setInterval: scheduleInterval = globalThis.setInterval,
    clearInterval: cancelInterval = globalThis.clearInterval,
  } = {},
) {
  let enabled = true;
  let installed = false;
  const isEnabled = () => enabled;
  const indicator = connectActivityIndicator(pi);
  const timer = createRunTimer(pi, { indicator, now, scheduleInterval, cancelInterval });
  const footer = createFooter(pi, { gitReader, isEnabled });

  function activate(ctx) {
    if (ctx.mode !== 'tui' || !enabled) return;
    installed = true;
    installChrome(ctx);
    timer.show(ctx);
    footer.install(ctx);
  }

  function deactivate(ctx) {
    if (!installed || ctx.mode !== 'tui') return;
    installed = false;
    const footerInstalled = footer.uninstall();
    timer.hide();
    restoreDefaults(ctx, { footer: footerInstalled });
  }

  pi.registerEntryRenderer(TIMER_ENTRY_TYPE, renderTimingEntry);

  pi.on('session_start', (event, ctx) => {
    installed = false;
    footer.reset();
    timer.reset();
    const previousEntries = forkSourceEntries(event);
    pendingInMemoryForkEntries = [];
    timer.restoreBranch(ctx, previousEntries);
    activate(ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    footer.clearCompactionState();
    deactivate(ctx);
  });

  registerTimerEvents(pi, timer, footer);
  registerRenderEvents(pi, { timer, footer, isEnabled });

  pi.registerCommand('graphite-ui', {
    description: 'Enable, disable, or refresh the Graphite interface',
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value === 'refresh') return refreshCommand(ctx, { footer, isEnabled });
      if (value && value !== 'on' && value !== 'off') {
        if (ctx.hasUI) ctx.ui.notify('Usage: /graphite-ui [on|off|refresh]', 'warning');
        return;
      }
      enabled = value ? value === 'on' : !enabled;
      if (enabled) activate(ctx);
      else deactivate(ctx);
      if (ctx.hasUI) ctx.ui.notify(`Graphite UI ${enabled ? 'enabled' : 'disabled'}`, 'info');
    },
  });
}
