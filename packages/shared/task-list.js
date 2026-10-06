import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

// Section headings are presentation rows, never selectable tasks. Keep selection
// by ID so a completion can move a task between sections without moving focus.
export function createTaskList({ theme, keybindings, selectedId, onSelect, onCancel, activeLabel = 'Running' }) {
  let items = [];
  let selected = 0;
  let pageSize = 1;
  const isKey = (data, action, key) => keybindings?.matches?.(data, action) || matchesKey(data, key);
  const move = (delta, wrap = false) => {
    if (!items.length) return;
    selected = wrap
      ? (selected + delta + items.length) % items.length
      : Math.max(0, Math.min(items.length - 1, selected + delta));
  };
  const heading = (running, count) =>
    theme.fg(running ? 'warning' : 'muted', `${running ? activeLabel : 'Finished'} (${count})`);
  return {
    getSelectedItem() {
      return items[selected];
    },
    setItems(next) {
      const id = items[selected]?.value ?? selectedId;
      items = next;
      selected = Math.max(
        0,
        items.findIndex(item => item.value === id),
      );
    },
    render(width, height) {
      pageSize = Math.max(1, height - 1);
      const layout = [];
      for (const running of [true, false]) {
        if (!running) layout.push({ text: '' });
        const section = items.filter(item => item.running === running);
        const title = heading(running, section.length);
        layout.push({ text: title });
        for (const item of section) {
          const focused = item === items[selected];
          const prefix = theme.fg(focused ? 'accent' : 'muted', focused ? '→' : ' ');
          const label = focused ? theme.fg('accent', item.label) : item.label;
          layout.push({ item, title, text: `${prefix} ${theme.fg(item.color, item.marker)} ${label}` });
        }
      }
      const selectedRow = Math.max(
        0,
        layout.findIndex(row => row.item === items[selected]),
      );
      // Reserve room for a repeated section title when scrolling inside a group.
      const room = Math.max(1, height - 1);
      const start = Math.max(0, Math.min(selectedRow - Math.floor(room / 2), layout.length - room));
      const sticky = height > 1 && start > 0 && layout[start].item ? [layout[start].title] : [];
      return [...sticky, ...layout.slice(start, start + height - sticky.length).map(row => row.text)].map(line =>
        truncateToWidth(line, width, ''),
      );
    },
    handleInput(data) {
      if (isKey(data, 'tui.select.cancel', Key.escape)) onCancel();
      else if (isKey(data, 'tui.select.confirm', Key.enter)) {
        if (items[selected]) onSelect(items[selected]);
      } else if (matchesKey(data, Key.home)) move(-items.length);
      else if (matchesKey(data, Key.end)) move(items.length);
      else if (matchesKey(data, Key.pageUp)) move(-pageSize);
      else if (matchesKey(data, Key.pageDown)) move(pageSize);
      else if (isKey(data, 'tui.select.up', Key.up)) move(-1, true);
      else if (isKey(data, 'tui.select.down', Key.down)) move(1, true);
    },
    handleMouse(event) {
      if (event.type !== 'wheel' || !event.wheelDelta) return;
      move(event.wheelDelta < 0 ? -1 : 1);
      return { handled: true, render: true };
    },
  };
}
