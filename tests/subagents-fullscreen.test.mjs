import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { createSubagentUI } from '../packages/subagents/ui.js';
import { singleLineText } from '../packages/shared/terminal-text.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const agent = (id, state = 'running') => ({
  agentId: id,
  alias: id,
  title: `Mission ${id}`,
  task: 'Read',
  runs: [],
  run: {
    runId: `run-${id}`,
    state,
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: state === 'running' ? undefined : '2026-01-01T00:00:01Z',
  },
});
function harness(agents, overrides = {}) {
  const listeners = new Set();
  const stopped = [];
  const notes = [];
  const screens = [];
  const terminal = { rows: 40 };
  let renders = 0;
  const manager = {
    compactAgents: () => agents,
    activeAgentIds: () => agents.filter(a => a.run.state === 'running').map(a => a.agentId),
    findAgent: id => agents.find(a => a.agentId === id),
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    assertCurrentBranch() {},
    stop: async ({ agentId }) => {
      stopped.push(agentId);
    },
    transcript: async () => ({ text: '', nextCursor: undefined }),
    result: async () => ({ text: 'RESULT', nextCursor: undefined }),
    ...overrides.manager,
  };
  const ui = createSubagentUI({
    ctx: {
      mode: 'tui',
      ui: {
        setWidget() {},
        notify: message => notes.push(message),
        custom: (factory, options) =>
          new Promise(resolve => {
            screens.push({
              component: factory(
                {
                  terminal,
                  requestRender() {
                    renders++;
                  },
                },
                { fg: (_name, text) => text },
                {},
                resolve,
              ),
              options,
            });
          }),
      },
    },
    manager,
    getConfig: async () => ({ autoDelegate: true, maxConcurrent: 4 }),
    ...overrides.config,
  });
  return {
    ui,
    terminal,
    stopped,
    notes,
    screens,
    listeners,
    get renders() {
      return renders;
    },
    get component() {
      return screens.at(-1).component;
    },
    emit(event = {}) {
      for (const listener of listeners) listener(event);
    },
  };
}
function fullScreen(h, width = 80) {
  assert.deepEqual(h.screens.at(-1).options, {
    overlay: true,
    overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 },
  });
  const lines = h.component.render(width);
  assert.equal(lines.length, h.terminal.rows);
  assert.ok(lines.every(line => visibleWidth(line) <= width));
  assert.match(lines.at(-1), /^─/u);
  return lines.join('\n');
}

test('subagent list fills the terminal, groups active/finished and keeps focus on completion', async t => {
  const agents = [agent('A1', 'completed'), agent('A2'), agent('A3', 'failed')];
  const h = harness(agents);
  t.after(() => h.ui.dispose());
  const opened = h.ui.open();
  let text = fullScreen(h);
  assert.match(text, /Active \(1\)/);
  assert.match(text, /Finished \(2\)/);
  assert.ok(text.indexOf('A2') < text.indexOf('A1'));
  h.component.handleInput('s');
  await tick();
  assert.deepEqual(h.stopped, ['A2']);
  agents[1].run.state = 'completed';
  h.emit();
  text = fullScreen(h);
  assert.match(text, /→.*A2/);
  h.component.handleInput('s');
  assert.deepEqual(h.stopped, ['A2']);
  for (const rows of [24, 60]) {
    h.terminal.rows = rows;
    fullScreen(h, 40);
  }
  h.component.handleInput('\x1b');
  await opened;
  assert.equal(h.listeners.size, 1, 'only the status widget remains subscribed');
});

test('detail fills the terminal and scrolls each view by page, wheel, Home and End', async t => {
  const archived = agent('A1', 'completed');
  archived.task = Array.from({ length: 80 }, (_, i) => `instruction-${i}`).join('\n');
  const h = harness([archived], {
    manager: {
      result: async () => ({
        text: Array.from({ length: 80 }, (_, i) => `response-${i}`).join('\n'),
        nextCursor: undefined,
      }),
      transcript: async ({ cursor = 0 }) => ({
        text: cursor
          ? ''
          : Array.from({ length: 80 }, (_, i) =>
              JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: `activity-${i}` }] } }),
            ).join('\n') + '\n',
        nextCursor: undefined,
      }),
    },
  });
  t.after(() => h.ui.dispose());
  const opened = h.ui.open();
  h.component.handleInput('\r');
  await tick();
  assert.match(fullScreen(h), /response-20/);
  for (const [tab, prefix] of [
    ['r', 'response'],
    ['a', 'activity'],
    ['i', 'instruction'],
  ]) {
    h.component.handleInput(tab);
    fullScreen(h);
    h.component.handleInput('\x1b[6~'); // Page Down
    assert.doesNotMatch(fullScreen(h), new RegExp(`${prefix}-0(?:\\s|$)`));
    h.component.handleInput('\x1b[F'); // End
    await tick();
    assert.match(fullScreen(h), new RegExp(`${prefix}-79`));
    h.component.handleInput('\x1b[H'); // Home
    assert.match(fullScreen(h), new RegExp(`${prefix}-0(?:\\s|$)`));
    h.component.handleMouse({ type: 'wheel', wheelDelta: 3, x: 5, y: 10 });
    assert.doesNotMatch(fullScreen(h), tab === 'i' ? /── Global/ : new RegExp(`${prefix}-0(?:\\s|$)`));
    h.component.handleInput('\x1b[5~'); // Page Up
    assert.match(fullScreen(h), new RegExp(`${prefix}-0(?:\\s|$)`));
  }
  for (const rows of [24, 60]) {
    h.terminal.rows = rows;
    fullScreen(h, 40);
  }
  h.component.handleInput('\x1b');
  await tick();
  assert.match(fullScreen(h), /Subagents/);
  assert.equal(h.listeners.size, 2, 'detail subscriptions were removed');
  h.component.handleInput('\x1b');
  await opened;
  assert.deepEqual(h.stopped, []);
});

test('detail opens at the start and preserves tail following across width and height changes', async t => {
  const h = harness([agent('A1', 'completed')], {
    manager: {
      result: async () => ({
        text: Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n'),
        nextCursor: undefined,
      }),
    },
  });
  t.after(() => h.ui.dispose());
  h.terminal.rows = 12;
  const opened = h.ui.open();
  h.component.handleInput('\r');
  await tick();
  assert.match(fullScreen(h), /line-0\s/);
  assert.doesNotMatch(fullScreen(h), /line-11/);
  h.component.handleInput('\x1b[F');
  await tick();
  assert.match(fullScreen(h), /line-11/);
  assert.match(fullScreen(h, 40), /line-11/);
  h.terminal.rows = 16;
  assert.match(fullScreen(h, 80), /line-11/);
  h.ui.dispose();
  await opened;
});

test('active activity opens at the live tail even when mounting refreshes before the first render', async t => {
  let entries =
    Array.from({ length: 12 }, (_, i) =>
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `entry-${i}` }],
        },
      }),
    ).join('\n') + '\n';
  const h = harness([agent('A1')], {
    manager: {
      transcript: async ({ cursor = 0 }) => ({ text: entries.slice(cursor), nextCursor: undefined }),
    },
  });
  t.after(() => h.ui.dispose());
  h.terminal.rows = 12;
  const opened = h.ui.open();
  h.component.handleInput('\r');
  await tick();
  assert.match(fullScreen(h), /entry-11/);
  assert.doesNotMatch(fullScreen(h), /entry-0\s/);
  h.component.handleInput('\x1b[F');
  await tick();
  assert.match(fullScreen(h), /entry-11/);
  assert.match(fullScreen(h, 40), /entry-11/);
  entries += JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'NEW-TAIL' }] } }) + '\n';
  h.emit({ agentId: 'A1' });
  await tick();
  assert.match(fullScreen(h, 40), /NEW-TAIL/);
  h.component.handleInput('\x1b[H');
  assert.match(fullScreen(h, 80), /entry-0\s/);
  h.ui.dispose();
  await opened;
});

test('Home remains authoritative after metadata refresh when short activity fits before resizing', async t => {
  const entries =
    Array.from({ length: 12 }, (_, i) =>
      JSON.stringify({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `short-${i}` }],
        },
      }),
    ).join('\n') + '\n';
  const h = harness([agent('A1')], {
    manager: {
      transcript: async ({ cursor = 0 }) => ({ text: entries.slice(cursor), nextCursor: undefined }),
    },
  });
  t.after(() => h.ui.dispose());
  const opened = h.ui.open();
  h.component.handleInput('\r');
  await tick();
  fullScreen(h);
  h.component.handleInput('\x1b[F');
  await tick();
  h.component.handleInput('\x1b[H');
  assert.match(fullScreen(h), /short-0\s/);
  h.emit({ agentId: 'A1' });
  await tick();
  h.terminal.rows = 12;
  const firstVisible = h.component
    .render(80)
    .map(singleLineText)
    .find(line => /short-\d/.test(line));
  assert.equal(firstVisible.trim(), 'short-0');
  h.ui.dispose();
  await opened;
});

test('End consumes pending response pages without changing another view position', async t => {
  const h = harness([agent('A1', 'completed')], {
    manager: {
      result: async ({ cursor }) =>
        cursor === undefined
          ? { text: 'FIRST\n', nextCursor: 1 }
          : cursor === 1
            ? { text: 'SECOND\n', nextCursor: 2 }
            : { text: 'LAST', nextCursor: undefined },
    },
  });
  t.after(() => h.ui.dispose());
  const opened = h.ui.open();
  h.component.handleInput('\r');
  await tick();
  fullScreen(h);
  h.component.handleInput('\x1b[F');
  await tick();
  assert.match(fullScreen(h), /LAST/);
  h.ui.dispose();
  await opened;
});

test('Home cancels an End jump whose response page is still loading', async t => {
  let release;
  const h = harness([agent('A1', 'completed')], {
    manager: {
      result: async ({ cursor }) =>
        cursor === undefined
          ? {
              text: Array.from({ length: 60 }, (_, i) => `first-${i}`).join('\n'),
              nextCursor: 1,
            }
          : new Promise(resolve => {
              release = () => resolve({ text: '\nLAST', nextCursor: undefined });
            }),
    },
  });
  t.after(() => h.ui.dispose());
  const opened = h.ui.open();
  h.component.handleInput('\r');
  await tick();
  fullScreen(h);
  h.component.handleInput('\x1b[F');
  await tick();
  assert.equal(typeof release, 'function');
  h.component.handleInput('\x1b[H');
  release();
  await tick();
  assert.match(fullScreen(h), /first-0\s/);
  assert.doesNotMatch(fullScreen(h), /LAST/);
  h.ui.dispose();
  await opened;
});

test('settings and numeric editor fill the terminal and persist only valid submissions', async t => {
  initTheme('dark');
  const saved = [];
  const h = harness([], {
    config: {
      updateConfig: async patch => {
        saved.push(patch);
        return { autoDelegate: true, maxConcurrent: 4, ...patch };
      },
    },
  });
  t.after(() => h.ui.dispose());
  const pending = h.ui.settings();
  await tick();
  const settings = fullScreen(h);
  assert.match(settings, /Global user settings/);
  assert.equal(
    settings.split('\n').filter(line => /Enter|Esc/.test(line)).length,
    1,
    'only the fixed footer shows keyboard help',
  );
  assert.doesNotMatch(settings, /Enter\/Space to change · Esc to cancel/);
  h.component.handleInput('\x1b[B');
  h.component.handleInput('\r');
  await tick();
  assert.match(fullScreen(h), /positive integer/);
  h.component.focused = true;
  h.component.handleInput('\x1b[F');
  h.component.handleInput('\x15'); // clear initial value
  h.component.handleInput('0');
  h.component.handleInput('\r');
  await tick();
  assert.deepEqual(saved, []);
  assert.match(fullScreen(h), /Positive integer required/);
  h.component.handleInput('\x15');
  h.component.handleInput('7');
  h.component.handleInput('\r');
  await tick();
  assert.deepEqual(saved, [{ maxConcurrent: 7 }]);
  fullScreen(h, 40);
  h.component.handleInput('\x1b[B');
  h.component.handleInput('\r');
  await tick();
  fullScreen(h);
  h.component.handleInput('\x1b'); // cancel editor, return to settings
  await tick();
  assert.match(fullScreen(h), /Global user settings/);
  assert.deepEqual(saved, [{ maxConcurrent: 7 }]);
  h.component.handleInput('\x1b');
  await pending;
});

test('pending limit saves cannot be duplicated and failures preserve input until cancellation', async t => {
  initTheme('dark');
  const attempts = [];
  let rejectSave;
  const h = harness([], {
    config: {
      updateConfig: patch => {
        attempts.push(patch);
        return new Promise((_, reject) => {
          rejectSave = reject;
        });
      },
    },
  });
  t.after(() => h.ui.dispose());
  const pending = h.ui.settings();
  await tick();
  h.component.handleInput('\x1b[B');
  h.component.handleInput('\r');
  await tick();
  const editor = h.component;
  editor.handleInput('\x1b[F');
  editor.handleInput('\x15');
  editor.handleInput('7');
  editor.handleInput('\r');
  assert.match(fullScreen(h), /Saving…/);
  editor.handleInput('\r');
  editor.handleInput('8');
  editor.handleInput('\x1b');
  assert.deepEqual(attempts, [{ maxConcurrent: 7 }]);
  rejectSave(new Error('read-only'));
  await tick();
  assert.equal(h.component, editor);
  assert.match(fullScreen(h), /Save failed: read-only/);
  assert.match(editor.render(80)[3], /7/);
  assert.deepEqual(h.notes, []);
  editor.handleInput('\x1b');
  await tick();
  assert.match(fullScreen(h), /Maximum concurrency.*4/);
  h.component.handleInput('\x1b');
  await pending;
});

test('disposing a pending limit save cannot reopen settings or announce stale success', async t => {
  initTheme('dark');
  let resolveSave;
  const h = harness([], {
    config: {
      updateConfig: patch =>
        new Promise(resolve => {
          resolveSave = () => resolve({ autoDelegate: true, maxConcurrent: 4, ...patch });
        }),
    },
  });
  t.after(() => h.ui.dispose());
  const pending = h.ui.settings();
  await tick();
  h.component.handleInput('\x1b[B');
  h.component.handleInput('\r');
  await tick();
  h.component.handleInput('\r');
  h.ui.dispose();
  await pending;
  resolveSave();
  await tick();
  assert.equal(h.screens.length, 2);
  assert.deepEqual(h.notes, []);
  assert.equal(h.listeners.size, 0);
});

test('list stop preserves branch protection and displays failures without closing the screen', async t => {
  const h = harness([agent('A1')], {
    manager: {
      assertCurrentBranch() {
        throw new Error('Wrong branch');
      },
    },
  });
  t.after(() => h.ui.dispose());
  const opened = h.ui.open();
  h.component.handleInput('s');
  assert.deepEqual(h.stopped, []);
  assert.match(fullScreen(h), /Wrong branch/);
  h.ui.dispose();
  await opened;
});

test('list uses the full height beyond ten missions and supports wheel navigation', async t => {
  const h = harness(Array.from({ length: 25 }, (_, i) => agent(`A${i + 1}`)));
  t.after(() => h.ui.dispose());
  const opened = h.ui.open();
  assert.match(fullScreen(h), /Mission A25/);
  h.component.handleInput('\x1b[F');
  assert.match(fullScreen(h), /→.*A25/);
  h.component.handleInput('\x1b[H');
  assert.match(fullScreen(h), /→.*A1/);
  h.terminal.rows = 12;
  fullScreen(h);
  h.component.handleInput('\x1b[6~');
  assert.doesNotMatch(fullScreen(h), /→.*A1\s/);
  h.component.handleInput('\x1b[5~');
  assert.match(fullScreen(h), /→.*A1\s/);
  h.component.handleMouse({ type: 'wheel', wheelDelta: 1, x: 5, y: 5 });
  assert.match(fullScreen(h), /→.*A2/);
  h.ui.dispose();
  await opened;
});
