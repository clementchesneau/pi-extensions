import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { createTaskList } from '@clement_chsn/pi-shared/task-list';
import { fullPageLines, showFullPage } from '@clement_chsn/pi-shared/full-page';
import { cumulativeDuration, stateLabel } from './format.js';
import { UNFINISHED_STATES } from './run-state.js';
import { trim } from './ui-detail-render.js';

const stateStyle = agent =>
  UNFINISHED_STATES.has(agent.run?.state)
    ? { marker: '●', color: 'warning' }
    : agent.run?.state === 'completed'
      ? { marker: '✓', color: 'success' }
      : agent.run?.state === 'failed'
        ? { marker: '✗', color: 'error' }
        : { marker: '■', color: 'muted' };

/** One row per agent, active first, with alias, state and duration aligned in columns. */
function listItems(manager) {
  const rows = manager
    .compactAgents()
    .map(agent => ({
      value: agent.agentId,
      running: UNFINISHED_STATES.has(agent.run?.state),
      ...stateStyle(agent),
      alias: truncateToWidth(trim(agent.alias), 20),
      state: stateLabel(agent.run?.state),
      elapsed: cumulativeDuration(agent),
      title: trim(agent.title, 100),
    }))
    .sort((a, b) => Number(b.running) - Number(a.running));
  const widthOf = field => Math.max(0, ...rows.map(row => visibleWidth(row[field])));
  const widths = { alias: widthOf('alias'), state: widthOf('state'), elapsed: widthOf('elapsed') };
  const pad = (text, width) => text + ' '.repeat(width - visibleWidth(text));
  return rows.map(row => ({
    ...row,
    label: `${pad(row.alias, widths.alias)}  ${pad(row.state, widths.state)}  ${pad(row.elapsed, widths.elapsed)}  · ${row.title}`,
  }));
}

function listLines(list, { theme, width, rows, error }) {
  const border = theme.fg('border', '─'.repeat(Math.max(0, width)));
  const row = text => truncateToWidth(` ${text}`, width);
  const running = list.getSelectedItem()?.running;
  const footer = [
    '',
    ...(error ? [row(theme.fg('error', error))] : []),
    row(theme.fg('dim', `↑↓ select · Enter open · ${running ? 's stop · ' : ''}Esc close`)),
    ...(running ? [row('Stopping does not undo changes.')] : []),
    border,
  ];
  const header = [border, row(theme.fg('accent', 'Subagents')), ''];
  const body = list.render(Math.max(1, width - 2), Math.max(1, rows - header.length - footer.length)).map(row);
  return fullPageLines(header, body, footer, rows);
}

/** Full-page agent list; resolves with the chosen agent ID, or null when closed. */
export function showAgentList({ ctx, manager, view, selectedId }) {
  return showFullPage(ctx, (tui, theme, keybindings, done) => {
    let closed = false;
    let error = '';
    let detach = () => {};
    let refreshTimer;
    const open = () => !closed && view.alive();
    const finish = value => {
      if (closed) return;
      closed = true;
      detach();
      clearInterval(refreshTimer);
      done(value);
    };
    view.close = () => finish(null);
    const list = createTaskList({
      theme,
      keybindings,
      selectedId,
      activeLabel: 'Active',
      onSelect: item => finish(item.value),
      onCancel: () => finish(null),
    });
    list.setItems(listItems(manager));
    const refresh = () => {
      if (!open()) return;
      list.setItems(listItems(manager));
      tui.requestRender();
    };
    detach = manager.subscribe(refresh);
    refreshTimer = setInterval(() => {
      if (manager.activeAgentIds().length) refresh();
    }, 1000);
    refreshTimer.unref?.();
    const stop = agentId => {
      try {
        manager.assertCurrentBranch(agentId);
      } catch (cause) {
        error = trim(cause.message, 300);
        refresh();
        return false;
      }
      void manager
        .stop({ agentId })
        .catch(cause => {
          if (open()) error = trim(cause.message, 300);
        })
        .finally(refresh);
      return true;
    };
    return {
      render: width => listLines(list, { theme, width, rows: tui.terminal?.rows ?? 40, error }),
      invalidate() {},
      handleInput(data) {
        if (!open()) return;
        const selected = list.getSelectedItem();
        if (data === 's' && selected?.running) {
          if (!stop(selected.value)) return;
        } else list.handleInput(data);
        tui.requestRender();
      },
      handleMouse(event) {
        if (!open() || event.y < 3 || event.y >= (tui.terminal?.rows ?? 40) - 4) return;
        const result = list.handleMouse({ ...event, x: event.x - 1, y: event.y - 3 });
        if (result?.handled) tui.requestRender();
        return result;
      },
    };
  });
}
