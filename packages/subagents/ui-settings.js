import { getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import { Input, SettingsList, truncateToWidth } from '@earendil-works/pi-tui';
import { fullPageLines, showFullPage } from '@clement_chsn/pi-shared/full-page';
import { trim } from './ui-detail-render.js';

function pageLines({ theme, width, rows }, title, body, footer) {
  const border = theme.fg('border', '─'.repeat(Math.max(0, width)));
  const row = text => truncateToWidth(` ${text}`, width);
  return fullPageLines(
    [border, row(theme.fg('accent', title)), ''],
    body.map(row),
    ['', ...footer.map(([color, text]) => row(theme.fg(color, text))), border],
    rows,
  );
}

/** Full-page settings list; resolves with `{ id, value }` of the changed setting, or null. */
export function showSettingsList({ ctx, view, config }) {
  return showFullPage(ctx, (tui, theme, keybindings, done) => {
    let closed = false;
    const finish = value => {
      if (closed) return;
      closed = true;
      done(value);
    };
    view.close = () => finish(null);
    const open = () => !closed && view.alive();
    // The fullscreen footer owns the help; suppress SettingsList's inline hint.
    const list = new SettingsList(
      [
        {
          id: 'auto',
          label: 'Automatic delegation',
          currentValue: config.autoDelegate ? 'on' : 'off',
          values: ['on', 'off'],
        },
        {
          id: 'max',
          label: 'Maximum concurrency',
          currentValue: String(config.maxConcurrent),
          values: [String(config.maxConcurrent), 'edit…'],
        },
      ],
      5,
      { ...getSettingsListTheme(), hint: () => '' },
      (id, value) => finish({ id, value }),
      () => finish(null),
    );
    return {
      render: width =>
        pageLines(
          { theme, width, rows: tui.terminal?.rows ?? 40 },
          'Global user settings',
          list.render(Math.max(1, width - 2)),
          [['dim', '↑↓ select · Enter/Space change · Esc close']],
        ),
      invalidate() {
        list.invalidate();
      },
      handleInput(data) {
        if (!open()) return;
        if (keybindings?.matches?.(data, 'tui.select.cancel')) finish(null);
        else list.handleInput(data);
        tui.requestRender();
      },
      handleMouse(event) {
        if (!open() || event.y < 3 || event.y >= (tui.terminal?.rows ?? 40) - 3) return;
        const result = list.handleMouse({ ...event, x: event.x - 1, y: event.y - 3 });
        if (result?.handled) tui.requestRender();
        return result;
      },
    };
  });
}

/** Full-page editor of the global concurrency limit; resolves with the saved config, or undefined. */
export function showLimitEditor({ ctx, view, current, updateConfig }) {
  return showFullPage(ctx, (tui, theme, keybindings, done) => {
    let closed = false;
    let error = '';
    let saving = false;
    const open = () => !closed && view.alive();
    const finish = value => {
      if (closed) return;
      closed = true;
      done(value);
    };
    view.close = () => finish(undefined);
    const input = new Input();
    input.setValue(String(current));
    input.onSubmit = async value => {
      if (saving || !open()) return;
      if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
        error = 'Positive integer required';
        tui.requestRender();
        return;
      }
      saving = true;
      error = '';
      tui.requestRender();
      try {
        const next = await updateConfig({ maxConcurrent: Number(value) });
        if (open()) finish(next);
      } catch (cause) {
        if (open()) error = `Save failed: ${trim(cause.message)}`;
      } finally {
        saving = false;
        if (open()) tui.requestRender();
      }
    };
    input.onEscape = () => finish(undefined);
    return {
      get focused() {
        return input.focused;
      },
      set focused(value) {
        input.focused = value;
      },
      render: width =>
        pageLines(
          { theme, width, rows: tui.terminal?.rows ?? 40 },
          'Global limit (positive integer)',
          input.render(Math.max(1, width - 2)),
          [...(error ? [['error', error]] : []), ['dim', saving ? 'Saving…' : 'Enter save · Esc cancel']],
        ),
      invalidate() {
        input.invalidate();
      },
      handleInput(data) {
        // Do not mutate or cancel an input whose save is already in flight.
        if (!open() || saving) return;
        if (keybindings?.matches?.(data, 'tui.select.cancel')) finish(undefined);
        else input.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
