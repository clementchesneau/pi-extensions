import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from '@earendil-works/pi-coding-agent';
import activityIndicator, { formatStatusBar } from '../packages/activity-indicator/index.js';
import backgroundTasks from '../packages/background-tasks/index.js';
import { createSubagentUI } from '../packages/subagents/ui.js';
import { readFile } from 'node:fs/promises';
import { visibleWidth } from '@earendil-works/pi-tui';
import graphiteUi from '../packages/graphite-ui/index.js';
import { ACTIVITY_INDICATOR_EVENTS, connectActivityIndicator } from '../packages/shared/activity-indicator.js';
import { createFakePi } from './fixtures/fake-pi.mjs';

function setup(extensions) {
  const widgets = new Map();
  const bus = createEventBus();
  const ctx = {
    mode: 'tui',
    cwd: process.cwd(),
    ui: {
      setWidget: (id, factory) => (factory ? widgets.set(id, factory) : widgets.delete(id)),
      notify() {},
    },
  };
  const fakes = extensions.map(extension => {
    const fake = createFakePi({ events: bus });
    extension(fake.pi);
    return fake;
  });
  return {
    widgets,
    tools: new Map(fakes.flatMap(fake => [...fake.tools])),
    ctx,
    bus,
    async emit(name) {
      for (const fake of fakes) if (fake.handlers.has(name)) await fake.fire(name, {}, ctx);
    },
    status(width = 80) {
      return widgets
        .get('activity-indicator')?.(null, { fg: (_color, text) => text })
        .render(width)
        .join(' ');
    },
  };
}

const command = `node -e ${JSON.stringify('setInterval(() => {}, 1000)')}`;

test('one bar aligns duration and counts on wide screens and stays on one line when narrow', () => {
  const values = [
    { count: 2, label: 'tâches' },
    { count: 1, label: 'sous-agent' },
  ];
  const wide = formatStatusBar(values, '⏱ 17s', 80);
  assert.equal(wide.length, 1);
  assert.match(wide[0], /^⏱ 17s +2 tâches · 1 sous-agent$/);
  for (const width of [0, 1, 8, 20, 32, 80]) {
    const lines = formatStatusBar(values, '⏱ 17s · 1m 30s · 2 comp', width);
    assert.ok(lines.length <= 1);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    if (width >= 20) assert.match(lines.join(''), /2 tâches/);
  }
  assert.deepEqual(formatStatusBar([], '', 80), []);
  const theme = { fg: (color, text) => `<${color}>${text}</${color}>` };
  assert.match(formatStatusBar([], '⏱ 17s', 80, theme)[0], /^<accent>/);
  assert.match(
    formatStatusBar(values, '⏱ 17s', 80, theme)[0],
    /^<accent>/,
    'active clock keeps its color beside counts',
  );
  assert.match(
    formatStatusBar(values, 'Total 1m', 80, theme, false)[0],
    /^<dim>/,
    'idle total is dim even beside counts',
  );
});

function loadGraphite(h) {
  const clock = { now: 0, tick: undefined };
  const entries = [];
  const fake = createFakePi({ events: h.bus });
  const widgets = h.widgets;
  const ctx = {
    ...h.ctx,
    sessionManager: {
      getSessionId: () => 'test',
      getBranch: () => entries,
      getEntries: () => entries,
    },
    getContextUsage: () => ({ percent: 0 }),
    ui: {
      ...h.ctx.ui,
      theme: { fg: (_color, text) => text },
      setTheme: () => ({ success: true }),
      setTitle() {},
      setWorkingIndicator() {},
      setHeader() {},
      setFooter() {},
      setWidget: (id, widget) => (widget ? widgets.set(id, widget) : widgets.delete(id)),
    },
  };
  graphiteUi(fake.pi, {
    now: () => clock.now,
    setInterval: fn => {
      clock.tick = fn;
      return 1;
    },
    clearInterval() {},
    gitReader: async () => ({ state: 'outside' }),
  });
  return { clock, ctx, fire: fake.fire, commands: fake.commands };
}

test('Graphite publishes its clock into the shared widget while tasks stay independent', async () => {
  const h = setup([activityIndicator, backgroundTasks]);
  const { clock, ctx, fire, commands } = loadGraphite(h);
  const widgets = h.widgets;
  await h.emit('session_start');
  await fire('session_start', {}, ctx);
  try {
    const task = JSON.parse(
      (await h.tools.get('task_start').execute('t', { title: 'Activité avec Graphite', command }, null, null, h.ctx))
        .content[0].text,
    );
    await fire('agent_start', {}, ctx);
    clock.now = 17_000;
    clock.tick();
    assert.deepEqual([...widgets.keys()], ['activity-indicator']);
    assert.match(h.status(80), /^⏱ 17s +1 task$/);
    assert.equal(h.status(80).split('\n').length, 1);
    await fire('agent_settled', {}, ctx);
    assert.equal(h.status(80), '1 task');
    await commands.get('graphite-ui').handler('off', ctx);
    assert.equal(h.status(80), '1 task', 'disabling Graphite leaves task status intact');
    await commands.get('graphite-ui').handler('on', ctx);
    assert.equal(h.status(80), '1 task');
    await h.tools.get('task_stop').execute('t', { id: task.id });
    assert.equal(widgets.size, 0);
  } finally {
    await fire('session_shutdown', {}, ctx);
    await h.emit('session_shutdown');
  }
});

test('shared indicator owns the only background task widget, updates and clears with the session', async () => {
  const h = setup([activityIndicator, backgroundTasks]);
  await h.emit('session_start');
  try {
    assert.equal(h.widgets.size, 0);
    const task = JSON.parse(
      (await h.tools.get('task_start').execute('t', { title: 'Activité partagée', command }, null, null, h.ctx))
        .content[0].text,
    );
    assert.deepEqual([...h.widgets.keys()], ['activity-indicator']);
    assert.match(h.status(), /1 task/);
    assert.match(h.status(22), /task/);
    await h.tools.get('task_stop').execute('t', { id: task.id });
    assert.equal(h.widgets.size, 0);
  } finally {
    await h.emit('session_shutdown');
  }
  assert.equal(h.widgets.size, 0);
});

test('two producers share one status and remove only their own contribution', async () => {
  const h = setup([activityIndicator, backgroundTasks]);
  const indicator = connectActivityIndicator({ events: h.bus });
  await h.emit('session_start');
  let agents = [{ run: { state: 'running' } }];
  const listeners = new Set();
  const manager = {
    compactAgents: () => agents,
    subscribe: callback => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    activeAgentIds: () => (agents.length ? ['a'] : []),
  };
  const ui = createSubagentUI({
    ctx: h.ctx,
    manager,
    getConfig: async () => ({ maxConcurrent: 4 }),
    indicator,
  });
  try {
    const task = JSON.parse(
      (await h.tools.get('task_start').execute('t', { title: 'Activité avec sous-agent', command }, null, null, h.ctx))
        .content[0].text,
    );
    assert.deepEqual([...h.widgets.keys()], ['activity-indicator']);
    assert.match(h.status(), /1 subagent · 1 task/);
    agents = [];
    for (const listener of listeners) listener({});
    assert.match(h.status(), /1 task/);
    assert.doesNotMatch(h.status(), /sous-agent/);
    await h.tools.get('task_stop').execute('t', { id: task.id });
    assert.equal(h.widgets.size, 0);
  } finally {
    ui.dispose();
    await h.emit('session_shutdown');
  }
});

test('package loads the indicator first so producers never start on their own widget', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const paths = manifest.pi.extensions;
  assert.ok(paths.indexOf('./packages/activity-indicator/index.js') < paths.indexOf('./packages/graphite-ui/index.js'));
  assert.ok(paths.indexOf('./packages/activity-indicator/index.js') < paths.indexOf('./packages/subagents/index.js'));
  assert.ok(
    paths.indexOf('./packages/activity-indicator/index.js') < paths.indexOf('./packages/background-tasks/index.js'),
  );
});

test('background tasks keep their independent widget when the indicator is not loaded', async () => {
  const h = setup([backgroundTasks]);
  await h.emit('session_start');
  try {
    const task = JSON.parse(
      (await h.tools.get('task_start').execute('t', { title: 'Activité autonome', command }, null, null, h.ctx))
        .content[0].text,
    );
    assert.deepEqual([...h.widgets.keys()], ['background-tasks-status']);
    await h.tools.get('task_stop').execute('t', { id: task.id });
  } finally {
    await h.emit('session_shutdown');
  }
});

test('producers loaded before the indicator move into the shared bar once it announces itself', async () => {
  const h = setup([backgroundTasks, activityIndicator]);
  const indicator = connectActivityIndicator({ events: h.bus });
  let agents = [{ run: { state: 'running' } }];
  const listeners = new Set();
  const manager = {
    compactAgents: () => agents,
    subscribe: callback => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    activeAgentIds: () => (agents.length ? ['a'] : []),
  };
  // The subagent widget exists before any bar: it starts on its own widget.
  const ui = createSubagentUI({ ctx: h.ctx, manager, getConfig: async () => ({ maxConcurrent: 4 }), indicator });
  assert.deepEqual([...h.widgets.keys()], ['subagents-status']);
  try {
    for (const session of [1, 2]) {
      await h.emit('session_start');
      const task = JSON.parse(
        (await h.tools.get('task_start').execute('t', { title: `Session ${session}`, command }, null, null, h.ctx))
          .content[0].text,
      );
      assert.deepEqual([...h.widgets.keys()], ['activity-indicator'], `session ${session}`);
      assert.match(h.status(), /1 subagent · 1 task/);
      await h.tools.get('task_stop').execute('t', { id: task.id });
      assert.match(h.status(), /^1 subagent$/);
      await h.emit('session_shutdown');
    }
    agents = [];
    for (const listener of listeners) listener({});
  } finally {
    ui.dispose();
  }
});

test('an indicator speaking another protocol version leaves producers on their own widgets', async () => {
  const h = setup([backgroundTasks]);
  await h.emit('session_start');
  h.bus.emit(ACTIVITY_INDICATOR_EVENTS.ready, { protocol: 2 });
  try {
    const task = JSON.parse(
      (await h.tools.get('task_start').execute('t', { title: 'Protocole futur', command }, null, null, h.ctx))
        .content[0].text,
    );
    assert.deepEqual([...h.widgets.keys()], ['background-tasks-status']);
    await h.tools.get('task_stop').execute('t', { id: task.id });
  } finally {
    await h.emit('session_shutdown');
  }
});

test('Graphite loaded before the indicator hands its clock over to the shared bar', async () => {
  const h = setup([activityIndicator]);
  const { clock, ctx, fire } = loadGraphite(h);
  await fire('session_start', {}, ctx);
  try {
    await fire('agent_start', {}, ctx);
    assert.deepEqual([...h.widgets.keys()], ['graphite-ui-timer']);
    await h.emit('session_start');
    clock.now = 5_000;
    clock.tick();
    assert.deepEqual([...h.widgets.keys()], ['activity-indicator']);
    assert.equal(h.status(80), '⏱ 5s');
  } finally {
    await fire('session_shutdown', {}, ctx);
    await h.emit('session_shutdown');
  }
  assert.equal(h.widgets.size, 0);
});
