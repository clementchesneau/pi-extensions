import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import { createTaskList } from '@clement_chsn/pi-shared/task-list';
import { fullPageLines, showFullPage } from '@clement_chsn/pi-shared/full-page';
import { singleLineText } from '@clement_chsn/pi-shared/terminal-text';
import { LogWindow } from './log-window.js';

const STATUS_WIDGET = 'background-tasks-status';

const active = task => task.state === 'running' || (['stopped', 'timed_out'].includes(task.state) && !task.finishedAt);
const stateLabel = task =>
  ({ running: 'running', completed: 'completed', failed: 'failed', stopped: 'stopped', timed_out: 'timed out' })[
    task.state
  ] ?? task.state;
const sorted = manager =>
  manager.list().sort((a, b) => Number(active(b)) - Number(active(a)) || b.startedAt.localeCompare(a.startedAt));
const duration = (task, now = Date.now()) => {
  const start = Date.parse(task.startedAt);
  const end = task.finishedAt ? Date.parse(task.finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'duration unavailable';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
};
const stateStyle = task =>
  active(task)
    ? { marker: '●', color: 'warning' }
    : task.state === 'completed'
      ? { marker: '✓', color: 'success' }
      : task.state === 'failed'
        ? { marker: '✗', color: 'error' }
        : { marker: '■', color: 'muted' };
const terminalRows = tui => tui.terminal?.rows ?? 40;

/** Active-task count in the shared activity bar when one is loaded, otherwise in its own widget. */
function createStatus(ctx, manager, indicator) {
  let disposed = false;
  let ownWidget = false;
  const publish = count =>
    indicator.update({ source: 'background-tasks', label: count === 1 ? 'task' : 'tasks', count });
  const render = () => {
    if (disposed) return;
    const count = manager.list().filter(active).length;
    if (indicator?.available) {
      if (ownWidget) ctx.ui.setWidget?.(STATUS_WIDGET, undefined);
      ownWidget = false;
      publish(count);
      return;
    }
    ownWidget = count > 0;
    ctx.ui.setWidget?.(
      STATUS_WIDGET,
      count
        ? (_tui, theme) => ({
            render: width => [
              truncateToWidth(theme.fg('muted', `${count} background task${count > 1 ? 's' : ''} · /ps`), width),
            ],
            invalidate() {},
          })
        : undefined,
    );
  };
  const unsubscribe = manager.subscribe(render);
  const stopFollowingIndicator = indicator?.onReady(render);
  render();
  return () => {
    disposed = true;
    unsubscribe();
    stopFollowingIndicator?.();
    if (indicator?.available) publish(0);
    if (ownWidget) ctx.ui.setWidget?.(STATUS_WIDGET, undefined);
  };
}

function listItems(manager) {
  return sorted(manager).map(task => ({
    value: task.id,
    running: active(task),
    ...stateStyle(task),
    label: `${stateLabel(task).padEnd(15)} · ${duration(task)} · ${singleLineText(task.title)} · ${task.id.slice(0, 8)}`,
  }));
}

/** Full-page task list; resolves with the chosen task ID, or null when closed. */
function showTaskList(ctx, manager, view, selectedId) {
  return showFullPage(ctx, (tui, theme, keybindings, done) => {
    let closed = false;
    let detach = () => {};
    let timer;
    const finish = value => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      detach();
      done(value);
    };
    view.close = () => finish(null);
    const list = createTaskList({
      theme,
      keybindings,
      selectedId,
      onSelect: item => finish(item.value),
      onCancel: () => finish(null),
    });
    list.setItems(listItems(manager));
    const refresh = () => {
      if (closed || view.disposed) return;
      list.setItems(listItems(manager));
      tui.requestRender();
    };
    detach = manager.subscribe(refresh);
    timer = setInterval(() => {
      if (manager.list().some(active)) refresh();
    }, 1000);
    timer.unref?.();
    return {
      render(width) {
        const border = theme.fg('border', '─'.repeat(width));
        const hint = `↑↓ select · Enter open · ${list.getSelectedItem()?.running ? 's stop · ' : ''}Esc close`;
        return fullPageLines(
          [border, truncateToWidth(` ${theme.fg('accent', 'Tasks')}`, width), ''],
          list
            .render(Math.max(1, width - 2), Math.max(1, terminalRows(tui) - 6))
            .map(line => (line ? truncateToWidth(` ${line}`, width) : '')),
          ['', truncateToWidth(` ${theme.fg('dim', hint)}`, width), border],
          terminalRows(tui),
        );
      },
      invalidate() {},
      handleInput(data) {
        const selected = list.getSelectedItem();
        if (data === 's' && selected && active(manager.get(selected.value))) {
          void manager
            .stop(selected.value)
            .catch(cause => {
              if (!closed && !view.disposed) ctx.ui.notify(cause.message, 'error');
            })
            .finally(refresh);
        } else list.handleInput(data);
        tui.requestRender();
      },
      handleMouse(event) {
        if (event.y < 3 || event.y >= terminalRows(tui) - 3) return;
        const result = list.handleMouse({ ...event, x: event.x - 1, y: event.y - 3 });
        if (result?.handled) tui.requestRender();
        return result;
      },
    };
  });
}

function detailLines(task, log, theme, { width, rows }) {
  const border = theme.fg('border', '─'.repeat(Math.max(0, width)));
  const row = text => truncateToWidth(` ${text}`, width);
  const tab = name => theme.fg(log.stream === name ? 'accent' : 'muted', `${name} (${task[`${name}Bytes`] ?? 0}B)`);
  const title = `Task ${task.id.slice(0, 8)} · ${singleLineText(task.title)} · ${stateLabel(task)} · ${duration(task)}${task.pid ? ` · PID ${task.pid}` : ''}`;
  const header = [
    border,
    row(theme.fg('accent', title)),
    row(theme.fg('muted', singleLineText(task.command))),
    '',
    row(`${tab('stdout')} | ${tab('stderr')}`),
    '',
  ];
  const footer = [
    '',
    ...(log.error ? [row(theme.fg('error', singleLineText(log.error)))] : []),
    ...(log.truncated ? [row(theme.fg('warning', 'Earlier logs removed by the retention limit.'))] : []),
    row(theme.fg('dim', `↑↓ scroll · t switch stream · ${active(task) ? 's stop · ' : ''}Esc back`)),
    border,
  ];
  const body = log.viewport(width, Math.max(1, rows - header.length - footer.length));
  return fullPageLines(header, body.length ? body.map(row) : [row(theme.fg('muted', 'No output yet.'))], footer, rows);
}

const LOG_NAVIGATION = [
  { key: Key.end, run: log => log.jumpTail() },
  { key: Key.home, run: log => log.home() },
  { key: Key.down, run: log => log.move(1) },
  { key: Key.up, run: log => log.move(-1) },
  { key: Key.pageDown, run: log => log.move(log.height) },
  { key: Key.pageUp, run: log => log.move(-log.height) },
];

/** Full-page log of one task, following its tail until the user scrolls up. */
async function showTaskDetail(ctx, manager, view, id) {
  let closed = false;
  let repaint = () => {};
  const log = new LogWindow({
    read: (offset, length, stream) => manager.output(id, offset, length, stream),
    totalBytes: stream => manager.get(id)[`${stream}Bytes`] ?? manager.get(id).totalBytes,
    isOpen: () => !closed && !view.disposed,
    changed: () => repaint(),
  });
  await log.open();
  if (view.disposed) return;
  await showFullPage(ctx, (tui, theme, keybindings, done) => {
    repaint = () => {
      if (!closed && !view.disposed) tui.requestRender();
    };
    const timer = setInterval(() => {
      if (log.following) void log.readPage('newer');
      else if (active(manager.get(id))) repaint();
    }, 500);
    timer.unref?.();
    const detach = manager.subscribe(repaint);
    view.close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      detach();
      done(null);
    };
    // Output may have arrived between the initial read and subscription.
    if (log.following) void log.readPage('newer');
    return {
      render: width => detailLines(manager.get(id), log, theme, { width, rows: terminalRows(tui) }),
      invalidate() {},
      handleMouse(event) {
        if (event.type === 'wheel' && event.wheelDelta) {
          log.move(event.wheelDelta);
          return { handled: true, render: true };
        }
      },
      handleInput(data) {
        const navigation = LOG_NAVIGATION.find(({ key }) => matchesKey(data, key));
        if (keybindings?.matches?.(data, 'tui.select.cancel') || matchesKey(data, Key.escape)) view.close();
        else if (data === 't' || matchesKey(data, Key.tab)) log.switchStream();
        else if (navigation) navigation.run(log);
        else if (data === 's' && active(manager.get(id))) {
          void manager.stop(id).catch(cause => {
            log.error = cause.message;
            repaint();
          });
        }
      },
    };
  });
}

export function createTasksUI(ctx, manager, indicator) {
  if (ctx.mode !== 'tui') return { open: async () => {}, dispose() {} };
  // `close` ends whichever full page is open; `disposed` ends the whole UI.
  const view = { close: undefined, disposed: false };
  const disposeStatus = createStatus(ctx, manager, indicator);

  async function open() {
    let selectedId;
    while (!view.disposed) {
      if (!manager.list().length) {
        ctx.ui.notify('No tasks in this session.');
        return;
      }
      const choice = await showTaskList(ctx, manager, view, selectedId);
      view.close = undefined;
      if (!choice || view.disposed) return;
      selectedId = choice;
      await showTaskDetail(ctx, manager, view, choice);
      view.close = undefined;
    }
  }

  return {
    open,
    dispose() {
      if (view.disposed) return;
      view.disposed = true;
      disposeStatus();
      view.close?.();
    },
  };
}
