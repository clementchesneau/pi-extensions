import * as publicSdk from '@earendil-works/pi-coding-agent';
import { formatStatus } from './format.js';
import { UNFINISHED_STATES } from './run-state.js';
import { trim } from './ui-detail-render.js';
import { showAgentDetail } from './ui-detail.js';
import { showAgentList } from './ui-list.js';
import { showLimitEditor, showSettingsList } from './ui-settings.js';

export { readableResponse } from './ui-detail-render.js';

/** Count of unfinished subagents: on the shared activity bar when one is loaded, otherwise in this extension's widget. */
function createStatusDisplay({ ctx, manager, indicator, alive }) {
  let maxConcurrent = 4;
  let publishedCount;
  let ownWidget = false;
  const publish = count =>
    indicator.update({ source: 'subagents', label: count === 1 ? 'subagent' : 'subagents', count });
  const refresh = () => {
    if (!alive()) return;
    const agents = manager.compactAgents();
    const count = agents.filter(agent => UNFINISHED_STATES.has(agent.run?.state)).length;
    if (indicator?.available) {
      if (ownWidget) ctx.ui.setWidget?.('subagents-status', undefined);
      ownWidget = false;
      if (count !== publishedCount) {
        publishedCount = count;
        publish(count);
      }
      return;
    }
    ownWidget = count > 0;
    if (!count) {
      ctx.ui.setWidget?.('subagents-status', undefined);
      return;
    }
    ctx.ui.setWidget?.('subagents-status', (_tui, theme) => ({
      render: width => formatStatus(manager.compactAgents(), { maxConcurrent }, width, theme),
      invalidate() {},
    }));
  };
  return {
    refresh,
    /** Publishes the count again, even unchanged. */
    republish() {
      publishedCount = undefined;
      refresh();
    },
    setMaxConcurrent(value) {
      maxConcurrent = value;
    },
    dispose() {
      if (indicator?.available) publish(0);
      if (ownWidget) ctx.ui.setWidget?.('subagents-status', undefined);
    },
  };
}

async function openAgents({ ctx, manager, sdk, view, alive }) {
  let selectedId;
  while (alive()) {
    if (!manager.compactAgents().length) {
      ctx.ui.notify('No subagents.');
      return;
    }
    const selection = await showAgentList({ ctx, manager, view, selectedId });
    view.close = undefined;
    if (!selection || !alive()) return;
    selectedId = selection;
    await showAgentDetail({ ctx, manager, sdk, view, agentId: selection });
  }
}

async function saveSetting({ ctx, view, alive, updateConfig, configChanged }, config, selected) {
  const next =
    selected.id === 'max'
      ? await showLimitEditor({ ctx, view, current: config.maxConcurrent, updateConfig }).finally(() => {
          view.close = undefined;
        })
      : await updateConfig({ autoDelegate: selected.value === 'on' });
  if (!alive() || next === undefined) return;
  configChanged(next);
  ctx.ui.notify(`Global settings saved: auto ${next.autoDelegate ? 'on' : 'off'} ; max ${next.maxConcurrent}`);
}

async function editSettings(ui) {
  const { ctx, view, alive, getConfig } = ui;
  while (alive()) {
    const config = await getConfig();
    if (!alive()) return;
    const selected = await showSettingsList({ ctx, view, config });
    view.close = undefined;
    if (!selected || !alive()) return;
    if (selected.id === 'max' && selected.value !== 'edit…') continue;
    try {
      await saveSetting(ui, config, selected);
    } catch (cause) {
      if (alive()) ctx.ui.notify(`Save failed: ${trim(cause.message)}`, 'warning');
    }
  }
}

export function createSubagentUI({
  ctx,
  manager,
  sdk = publicSdk,
  getConfig,
  updateConfig,
  isCurrent = () => true,
  indicator,
}) {
  if (ctx.mode !== 'tui') return { dispose() {}, open: async () => {}, settings: async () => {} };
  let disposed = false;
  const alive = () => !disposed && isCurrent();
  const status = createStatusDisplay({ ctx, manager, indicator, alive });
  const configChanged = config => {
    if (alive()) {
      status.setMaxConcurrent(config.maxConcurrent);
      status.refresh();
    }
  };
  const refreshConfig = () =>
    getConfig()
      .then(configChanged)
      .catch(() => {});
  const unsubscribe = manager.subscribe(() => status.refresh());
  // The bar asks for the whole state again, even an unchanged count.
  const stopFollowingIndicator = indicator?.onReady(() => status.republish());
  status.refresh();
  const ready = refreshConfig();
  const timer = setInterval(() => {
    if (manager.activeAgentIds().length) status.refresh();
  }, 1000);
  timer.unref?.();

  // `close` ends whichever full page is open; `alive` turns false once the UI is gone.
  const view = { close: undefined, alive };
  const ui = { ctx, manager, sdk, view, alive, getConfig, updateConfig, configChanged };

  return {
    open: () => openAgents(ui),
    settings: () => editSettings(ui),
    ready,
    configChanged,
    dispose() {
      if (disposed) return;
      disposed = true;
      view.close?.();
      view.close = undefined;
      clearInterval(timer);
      unsubscribe();
      stopFollowingIndicator?.();
      status.dispose();
    },
  };
}
