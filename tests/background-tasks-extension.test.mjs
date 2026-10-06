import test from 'node:test';
import assert from 'node:assert/strict';
import backgroundTasks from '../packages/background-tasks/index.js';
import { createTasksUI } from '../packages/background-tasks/ui.js';
import { createFakePi } from './fixtures/fake-pi.mjs';
import { visibleWidth } from '@earendil-works/pi-tui';

function harness() {
  const fake = createFakePi();
  const notices = [];
  const widgets = new Map();
  const screens = [];
  const screenOptions = [];
  const terminal = { rows: 40 };
  const ctx = {
    cwd: process.cwd(),
    mode: 'tui',
    ui: {
      notify: (...args) => notices.push(args),
      setWidget: (id, widget) => widgets.set(id, widget),
      custom: (factory, options) =>
        new Promise(resolve => {
          screenOptions.push(options);
          const tui = { terminal, requestRender() {} };
          screens.push(factory(tui, { fg: (_color, text) => text }, undefined, resolve));
        }),
    },
  };
  backgroundTasks(fake.pi);
  const { tools, commands, messages, fire } = fake;
  return {
    fire,
    tools,
    commands,
    notices,
    messages,
    widgets,
    screens,
    screenOptions,
    terminal,
    ctx,
    call: (name, params) =>
      tools
        .get(name)
        .execute(
          'test',
          name === 'task_start' ? { title: 'Tâche de test', ...params } : params,
          undefined,
          undefined,
          ctx,
        ),
  };
}
const command = script => `node -e ${JSON.stringify(script)}`;

test('task_start requires a short title and shows it in the listing and detail instead of the command', async () => {
  const h = harness();
  await h.fire('session_start', {}, h.ctx);
  try {
    const schema = h.tools.get('task_start').parameters;
    assert.ok(schema.required.includes('title'));
    assert.equal(schema.properties.title.maxLength, 80);
    for (const title of [undefined, '', '   ', 'x'.repeat(81)]) {
      await assert.rejects(h.call('task_start', { title, command: 'true' }), /title/i);
    }
    const title = 'Vérifier la sortie des tests';
    const started = JSON.parse(
      (await h.call('task_start', { title, command: 'echo RAW-COMMAND-ONLY' })).content[0].text,
    );
    await h.call('task_wait', { id: started.id, timeoutMs: 3000 });
    assert.equal(started.title, title);
    assert.equal(JSON.parse((await h.call('task_status', { id: started.id })).content[0].text).title, title);
    const opened = h.commands.get('ps').handler('', h.ctx);
    const listing = h.screens[0].render(120).join('\n');
    assert.match(listing, /Vérifier la sortie des tests/);
    assert.doesNotMatch(listing, /RAW-COMMAND-ONLY/);
    h.screens[0].handleInput('\r');
    await new Promise(resolve => setTimeout(resolve, 30));
    const detail = h.screens[1].render(120);
    assert.match(detail[1], new RegExp(`Task ${started.id.slice(0, 8)} · ${title} · completed`));
    assert.match(detail[2], /echo RAW-COMMAND-ONLY/);
    h.screens[1].handleInput('\x1b');
    await new Promise(resolve => setTimeout(resolve, 10));
    h.screens.at(-1).handleInput('\x1b');
    await opened;
  } finally {
    await h.fire('session_shutdown', {}, h.ctx);
  }
});

test('tool lifecycle: completion notifies and resumes only when requested, tree disables resume', async () => {
  const h = harness();
  await h.fire('session_start', {}, h.ctx);
  try {
    const first = JSON.parse(
      (await h.call('task_start', { command: command('console.log("hello")') })).content[0].text,
    );
    const done = JSON.parse((await h.call('task_wait', { id: first.id, timeoutMs: 3000 })).content[0].text);
    assert.equal(done.task.state, 'completed');
    assert.equal(h.messages.length, 0);
    const output = JSON.parse((await h.call('task_output', { id: first.id })).content[0].text);
    assert.match(output.text, /hello/);
    const second = JSON.parse(
      (await h.call('task_start', { command: command('setTimeout(() => {}, 120)'), resume: true })).content[0].text,
    );
    await h.call('task_wait', { id: second.id, timeoutMs: 3000 });
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].options.deliverAs, 'followUp');
    const third = JSON.parse(
      (await h.call('task_start', { command: command('setTimeout(() => {}, 120)'), resume: true })).content[0].text,
    );
    await h.fire('session_tree', {}, h.ctx);
    await h.call('task_wait', { id: third.id, timeoutMs: 3000 });
    assert.equal(h.messages.length, 1);
    const list = JSON.parse((await h.call('task_status', {})).content[0].text);
    assert.equal(list.total, 3);
    assert.equal(list.tasks.length, 3);
    const fourth = JSON.parse(
      (await h.call('task_start', { command: command('setTimeout(() => {}, 120)'), resume: true })).content[0].text,
    );
    await h.call('task_wait', { id: fourth.id, timeoutMs: 3000 });
    assert.equal(h.messages.length, 2, 'new tasks can resume after tree navigation');
  } finally {
    await h.fire('session_shutdown', {}, h.ctx);
  }
});

test('/ps has no subcommands; agent tools remain available and non-TUI listing still works', async () => {
  const h = harness();
  await h.fire('session_start', {}, h.ctx);
  try {
    assert.ok(h.commands.has('ps'));
    assert.equal(h.commands.has('tasks'), false);
    assert.doesNotMatch(h.commands.get('ps').description, /list|show|output|stop/);
    for (const name of ['task_start', 'task_status', 'task_wait', 'task_output', 'task_stop'])
      assert.ok(h.tools.has(name));
    for (const args of ['list', 'show unknown', 'output unknown', 'stop unknown']) {
      await h.commands.get('ps').handler(args, h.ctx);
      assert.deepEqual(h.notices.at(-1), ['Usage: /ps', 'error']);
    }
    assert.equal(h.screens.length, 0);
    await h.commands.get('ps').handler('', { ...h.ctx, mode: 'rpc' });
    assert.deepEqual(JSON.parse(h.notices.at(-1)[0]), { tasks: [], total: 0, omitted: 0 });
  } finally {
    await h.fire('session_shutdown', {}, h.ctx);
  }
});

test('s in the listing stops only the selected active task without opening its detail', async () => {
  const h = harness();
  await h.fire('session_start', {}, h.ctx);
  try {
    const older = JSON.parse(
      (await h.call('task_start', { command: command('setInterval(() => {}, 1000)') })).content[0].text,
    );
    const newer = JSON.parse(
      (await h.call('task_start', { command: command('setInterval(() => {}, 1000)') })).content[0].text,
    );
    const opened = h.commands.get('ps').handler('', h.ctx);
    const list = h.screens[0];
    assert.match(list.render(100).join('\n'), /↑↓ select · Enter open · s stop · Esc close/);
    list.handleInput('\x1b[B');
    assert.match(
      list.render(100).find(line => /→/.test(line)),
      new RegExp(older.id.slice(0, 8)),
    );
    list.handleInput('s');
    const done = JSON.parse((await h.call('task_wait', { id: older.id, timeoutMs: 3000 })).content[0].text);
    assert.equal(done.task.state, 'stopped');
    assert.equal(JSON.parse((await h.call('task_status', { id: newer.id })).content[0].text).state, 'running');
    assert.equal(h.screens.length, 1);
    assert.match(
      list.render(100).find(line => /→/.test(line)),
      /stopped/,
    );
    assert.doesNotMatch(list.render(100).join('\n'), /s stop/);
    list.handleInput('s');
    assert.equal(JSON.parse((await h.call('task_status', { id: older.id })).content[0].text).state, 'stopped');
    list.handleMouse({ type: 'wheel', button: 'none', x: 3, y: 5, wheelDelta: -1 });
    assert.match(list.render(100).join('\n'), /s stop/);
    list.handleInput('\x1b');
    await opened;
  } finally {
    await h.fire('session_shutdown', {}, h.ctx);
  }
});

test('a failed stop from the listing reports the error and leaves navigation available', async () => {
  const screens = [];
  const notices = [];
  const task = {
    id: 'example-task',
    title: 'Attendre',
    command: 'sleep 60',
    state: 'running',
    startedAt: new Date().toISOString(),
  };
  const manager = {
    list: () => [task],
    get: () => task,
    subscribe: () => () => {},
    stop: async () => {
      throw new Error('stop failed');
    },
  };
  const ctx = {
    mode: 'tui',
    ui: {
      notify: (...args) => notices.push(args),
      setWidget() {},
      custom: factory =>
        new Promise(resolve => {
          screens.push(
            factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_color, text) => text }, undefined, resolve),
          );
        }),
    },
  };
  const ui = createTasksUI(ctx, manager);
  try {
    const opened = ui.open();
    screens[0].handleInput('s');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(notices, [['stop failed', 'error']]);
    assert.equal(screens.length, 1);
    assert.match(screens[0].render(100).join('\n'), /running/);
    screens[0].handleInput('\x1b');
    await opened;
  } finally {
    ui.dispose();
  }
});

test('tasks widget and interactive list lead to a live output detail', async () => {
  const h = harness();
  await h.fire('session_start', {}, h.ctx);
  try {
    assert.equal(h.widgets.get('background-tasks-status'), undefined);
    const finished = JSON.parse(
      (await h.call('task_start', { command: command('console.log("finished")') })).content[0].text,
    );
    await h.call('task_wait', { id: finished.id, timeoutMs: 3000 });
    const running = JSON.parse(
      (
        await h.call('task_start', {
          command: command(
            'console.log("live"); setTimeout(() => console.log("later"), 200); setInterval(() => {}, 1000)',
          ),
        })
      ).content[0].text,
    );
    assert.match(
      h.widgets
        .get('background-tasks-status')(null, { fg: (_color, text) => text })
        .render(80)
        .join(''),
      /1 background task/,
    );
    const opened = h.commands.get('ps').handler('', h.ctx);
    assert.match(h.screens[0].render(100).join('\n'), /Tasks/);
    assert.ok(
      h.screens[0].render(100).join('\n').indexOf('running') < h.screens[0].render(100).join('\n').indexOf('completed'),
    );
    h.screens[0].handleInput('\r');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(h.screens.length, 2);
    assert.match(h.screens[1].render(100).join('\n'), /live/);
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.match(h.screens[1].render(100).join('\n'), /later/, 'new output appears without reopening the detail');
    assert.match(h.screens[1].render(100).join('\n'), /↑↓ scroll · t switch stream · s stop · Esc back/);
    h.screens[1].handleInput('s');
    await h.call('task_wait', { id: running.id, timeoutMs: 3000 });
    assert.equal(h.widgets.get('background-tasks-status'), undefined);
    assert.match(h.screens[1].render(100).join('\n'), /stopped/);
    h.screens[1].handleInput('\x1b');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(h.screens.length, 3, 'escape returns to the task list');
    h.screens[2].handleInput('\x1b');
    await opened;
    assert.equal(h.widgets.get('background-tasks-status'), undefined);
  } finally {
    await h.fire('session_shutdown', {}, h.ctx);
  }
});

test('list and detail fill the terminal and resize; clicks do not open tasks', async () => {
  const h = harness();
  await h.fire('session_start', {}, h.ctx);
  try {
    const task = JSON.parse(
      (await h.call('task_start', { command: command('console.log("full-page")') })).content[0].text,
    );
    await h.call('task_wait', { id: task.id, timeoutMs: 3000 });
    const opened = h.commands.get('ps').handler('', h.ctx);
    const list = h.screens[0];
    assert.equal(list.render(100).length, 40);
    assert.match(list.render(100).join('\n'), /Running \(0\)\n\n Finished \(1\)/);
    assert.equal(h.screenOptions[0].overlay, true);
    h.terminal.rows = 24;
    assert.equal(list.render(60).length, 24);
    list.handleMouse({ type: 'press', button: 'left', x: 3, y: 5 });
    list.handleMouse({ type: 'click', button: 'left', x: 3, y: 5 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(h.screens.length, 1);
    assert.match(list.render(100).join('\n'), /↑↓ select · Enter open · Esc close/);
    assert.doesNotMatch(list.render(100).join('\n'), /clic/);
    list.handleInput('\r');
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(h.screens.length, 2);
    const detailLines = h.screens[1].render(60);
    assert.equal(detailLines.length, 24);
    assert.match(detailLines[1], new RegExp(`PID ${task.pid}`));
    assert.equal(detailLines[3], '', 'a blank line separates command metadata from the output tabs');
    assert.match(detailLines[4], /stdout/);
    h.terminal.rows = 50;
    assert.equal(h.screens[1].render(100).length, 50);
    h.screens[1].handleInput('\x1b');
    await new Promise(resolve => setTimeout(resolve, 10));
    h.screens.at(-1).handleInput('\x1b');
    await opened;
  } finally {
    await h.fire('session_shutdown', {}, h.ctx);
  }
});

test('detail switches output streams and scrolls with the mouse without losing its position', async () => {
  const h = harness();
  await h.fire('session_start', {}, h.ctx);
  try {
    const script =
      'for (let i = 0; i < 100; i++) console.log("OUT-" + String(i).padStart(3, "0")); console.error("ERR-only");';
    const task = JSON.parse((await h.call('task_start', { command: command(script) })).content[0].text);
    await h.call('task_wait', { id: task.id, timeoutMs: 3000 });
    const stderr = JSON.parse((await h.call('task_output', { id: task.id, stream: 'stderr' })).content[0].text);
    assert.equal(stderr.text, 'ERR-only\n');
    const opened = h.commands.get('ps').handler('', h.ctx);
    h.screens[0].handleInput('\r');
    await new Promise(resolve => setTimeout(resolve, 70));
    const detail = h.screens[1];
    assert.match(detail.render(100).join('\n'), /OUT-099/);
    assert.doesNotMatch(detail.render(100).join('\n'), /ERR-only/);
    detail.handleMouse({ type: 'wheel', button: 'none', x: 10, y: 10, wheelDelta: -5 });
    assert.doesNotMatch(detail.render(100).join('\n'), /OUT-099/);
    const scrolled = detail.render(100).join('\n');
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(detail.render(100).join('\n'), scrolled);
    detail.handleInput('t');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(detail.render(100).join('\n'), /ERR-only/);
    assert.doesNotMatch(detail.render(100).join('\n'), /OUT-099/);
    detail.handleMouse({ type: 'click', button: 'left', x: 2, y: 3 });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(detail.render(100).join('\n'), /ERR-only/);
    assert.doesNotMatch(detail.render(100).join('\n'), /OUT-099/);
    assert.match(detail.render(100).join('\n'), /↑↓ scroll · t switch stream · Esc back/);
    assert.doesNotMatch(detail.render(100).join('\n'), /Home|End|PgUp|s arrêter/);
    detail.handleInput('\t');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(detail.render(100).join('\n'), /OUT-099/);
    detail.handleInput('\x1b');
    await new Promise(resolve => setTimeout(resolve, 10));
    h.screens.at(-1).handleInput('\x1b');
    await opened;
  } finally {
    await h.fire('session_shutdown', {}, h.ctx);
  }
});

test('full-page list uses the available rows, bounds wide labels and preserves mouse selection on resize', async () => {
  const screens = [];
  const terminal = { rows: 40 };
  const tasks = Array.from({ length: 60 }, (_, i) => ({
    id: `task-${i}`,
    title: `cmd-${i} ${'🦀界'.repeat(12)}`,
    state: 'completed',
    command: 'echo test',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:01Z',
  }));
  const manager = { list: () => [...tasks], subscribe: () => () => {} };
  const ctx = {
    mode: 'tui',
    ui: {
      setWidget() {},
      custom: factory =>
        new Promise(resolve => {
          screens.push(factory({ terminal, requestRender() {} }, { fg: (_color, text) => text }, undefined, resolve));
        }),
    },
  };
  const ui = createTasksUI(ctx, manager);
  try {
    const opened = ui.open();
    const list = screens[0];
    const lines = list.render(100);
    assert.ok(lines.filter(line => /cmd-/.test(line)).length > 10);
    for (let i = 0; i < 40; i++) list.handleMouse({ type: 'wheel', button: 'none', x: 3, y: 5, wheelDelta: 1 });
    assert.match(
      list.render(100).find(line => /→/.test(line)),
      /cmd-40 /,
    );
    terminal.rows = 12;
    const narrow = list.render(20);
    assert.equal(narrow.length, 12);
    assert.ok(narrow.every(line => visibleWidth(line) <= 20));
    assert.match(
      list.render(100).find(line => /→/.test(line)),
      /cmd-40 /,
    );
    list.handleInput('\x1b');
    await opened;
  } finally {
    ui.dispose();
  }
});

test('list separates running and finished tasks, sorts each by date and keeps selection when a task finishes', async () => {
  const screens = [];
  let changed;
  const make = (id, day, state) => ({
    id,
    title: id,
    command: `echo ${id}`,
    state,
    startedAt: `2026-01-0${day}T00:00:00Z`,
    finishedAt: state === 'running' ? null : `2026-01-0${day}T00:00:01Z`,
  });
  const tasks = [
    make('old-done', 1, 'completed'),
    make('new-running', 4, 'running'),
    make('old-running', 2, 'running'),
    make('new-done', 3, 'failed'),
  ];
  const manager = {
    list: () => [...tasks],
    subscribe: handler => {
      changed = handler;
      return () => {};
    },
  };
  const ctx = {
    mode: 'tui',
    ui: {
      setWidget() {},
      custom: factory =>
        new Promise(resolve => {
          screens.push(
            factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_color, text) => text }, undefined, resolve),
          );
        }),
    },
  };
  const ui = createTasksUI(ctx, manager);
  try {
    const opened = ui.open();
    const list = screens[0];
    const text = list.render(100).join('\n');
    assert.match(text, /Running \(2\)/);
    assert.match(text, /Finished \(2\)/);
    assert.match(text, /● running/);
    assert.match(text, /✓ completed/);
    assert.match(text, /✗ failed/);
    assert.ok(text.indexOf('Running (2)') < text.indexOf('new-running'));
    assert.ok(text.indexOf('new-running') < text.indexOf('old-running'));
    assert.ok(text.indexOf('old-running') < text.indexOf('Finished (2)'));
    const lines = text.split('\n');
    assert.equal(
      lines[lines.findIndex(line => /Finished \(2\)/.test(line)) - 1],
      '',
      'sections have a blank line between them',
    );
    assert.ok(text.indexOf('Finished (2)') < text.indexOf('new-done'));
    assert.ok(text.indexOf('new-done') < text.indexOf('old-done'));
    tasks[1].state = 'completed';
    tasks[1].finishedAt = '2026-01-04T00:00:01Z';
    changed();
    const after = list.render(100).join('\n');
    assert.match(after, /Running \(1\)/);
    assert.match(after, /Finished \(3\)/);
    assert.match(after, /Running \(1\)[\s\S]*old-running[^\n]*\n\n Finished \(3\)/);
    assert.match(
      after.split('\n').find(line => /→/.test(line)),
      /new-running/,
    );
    assert.ok(after.indexOf('Finished (3)') < after.indexOf('new-running'));
    list.handleInput('\x1b');
    await opened;
  } finally {
    ui.dispose();
  }
});

test('task list and detail show a live duration that freezes at completion', async () => {
  const screens = [];
  let repaints = 0;
  const task = {
    id: 'timed-task',
    title: 'Attendre deux secondes',
    command: 'sleep 2',
    state: 'running',
    startedAt: new Date(Date.now() - 200).toISOString(),
    finishedAt: null,
    totalBytes: 0,
  };
  const manager = {
    list: () => [task],
    get: () => task,
    subscribe: () => () => {},
    output: async () => ({ text: '', start: 0, nextOffset: 0, unavailableBefore: 0 }),
  };
  const ctx = {
    mode: 'tui',
    ui: {
      notify() {},
      setWidget() {},
      custom: factory =>
        new Promise(resolve => {
          screens.push(
            factory(
              {
                terminal: { rows: 40 },
                requestRender() {
                  repaints++;
                },
              },
              { fg: (_color, text) => text },
              undefined,
              resolve,
            ),
          );
        }),
    },
  };
  const ui = createTasksUI(ctx, manager);
  try {
    const opened = ui.open();
    assert.match(screens[0].render(100).join('\n'), /running\s+· 0s · Attendre deux secondes/);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.ok(repaints > 0, 'the list requests repaints while a task is running');
    assert.match(screens[0].render(100).join('\n'), /running\s+· 1s · Attendre deux secondes/);
    screens[0].handleInput('\r');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(screens[1].render(100).join('\n'), /Task timed-ta · Attendre deux secondes · running · 1s/);
    task.finishedAt = new Date(Date.parse(task.startedAt) + 1500).toISOString();
    task.state = 'completed';
    assert.match(screens[1].render(100).join('\n'), /Task timed-ta · Attendre deux secondes · completed · 1s/);
    screens[1].handleInput('\x1b');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(screens[2].render(100).join('\n'), /completed\s+· 1s · Attendre deux secondes/);
    screens[2].handleInput('\x1b');
    await opened;
  } finally {
    ui.dispose();
  }
});

test('task detail pages back to retained output older than the initial tail', async () => {
  const h = harness();
  await h.fire('session_start', {}, h.ctx);
  try {
    const script =
      'console.log("FIRST-LINE"); for (let i = 0; i < 350; i++) console.log(String(i).padStart(4, "0") + "x".repeat(64));';
    const started = JSON.parse((await h.call('task_start', { command: command(script) })).content[0].text);
    await h.call('task_wait', { id: started.id, timeoutMs: 3000 });
    const opened = h.commands.get('ps').handler('', h.ctx);
    h.screens[0].handleInput('\r');
    await new Promise(resolve => setTimeout(resolve, 70));
    const detail = h.screens[1];
    assert.doesNotMatch(detail.render(100).join('\n'), /^ FIRST-LINE$/m);
    detail.handleInput('\x1b[H'); // top of the initial tail
    detail.handleInput('\x1b[A'); // request an older page
    await new Promise(resolve => setTimeout(resolve, 100));
    detail.handleInput('\x1b[H');
    assert.match(detail.render(100).join('\n'), /^ FIRST-LINE$/m, 'old output is reachable in the detail');
    detail.handleInput('\x1b');
    await new Promise(resolve => setTimeout(resolve, 10));
    h.screens.at(-1).handleInput('\x1b');
    await opened;
  } finally {
    await h.fire('session_shutdown', {}, h.ctx);
  }
});

test('paged history stays bounded and End returns to live tail', async () => {
  const h = harness();
  await h.fire('session_start', {}, h.ctx);
  try {
    const script =
      'console.log("OLDEST"); for (let i = 0; i < 900; i++) console.log(String(i).padStart(4, "0") + "x".repeat(64)); console.log("LATEST");';
    const started = JSON.parse((await h.call('task_start', { command: command(script) })).content[0].text);
    await h.call('task_wait', { id: started.id, timeoutMs: 3000 });
    const opened = h.commands.get('ps').handler('', h.ctx);
    h.screens[0].handleInput('\r');
    await new Promise(resolve => setTimeout(resolve, 60));
    const detail = h.screens[1];
    for (let i = 0; i < 10; i++) {
      detail.handleInput('\x1b[H');
      detail.handleInput('\x1b[A');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    detail.handleInput('\x1b[H');
    assert.match(detail.render(100).join('\n'), /^ OLDEST$/m);
    detail.handleInput('\x1b[F');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.match(detail.render(100).join('\n'), /^ LATEST$/m);
    detail.handleInput('\x1b');
    await new Promise(resolve => setTimeout(resolve, 10));
    h.screens.at(-1).handleInput('\x1b');
    await opened;
  } finally {
    await h.fire('session_shutdown', {}, h.ctx);
  }
});

test('End wins over an older log page that resolves after the jump', async () => {
  const screens = [];
  let releaseOlder;
  const older = new Promise(resolve => {
    releaseOlder = resolve;
  });
  const task = {
    id: 'example-task',
    title: 'Afficher les logs',
    command: 'print logs',
    state: 'completed',
    startedAt: '2026-01-01T00:00:00Z',
    totalBytes: 20000,
  };
  const manager = {
    list: () => [task],
    get: () => task,
    subscribe: () => () => {},
    output: async (_id, offset) =>
      offset === undefined
        ? { text: 'TAIL\n', start: 16000, nextOffset: 20000, unavailableBefore: 0 }
        : offset < 16000
          ? older
          : { text: '', start: 20000, nextOffset: 20000, unavailableBefore: 0 },
  };
  const ctx = {
    mode: 'tui',
    ui: {
      notify() {},
      setWidget() {},
      custom: factory =>
        new Promise(resolve => {
          screens.push(
            factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_color, text) => text }, undefined, resolve),
          );
        }),
    },
  };
  const ui = createTasksUI(ctx, manager);
  try {
    const opened = ui.open();
    screens[0].handleInput('\r');
    await new Promise(resolve => setTimeout(resolve, 10));
    const detail = screens[1];
    detail.handleInput('\x1b[H');
    detail.handleInput('\x1b[A');
    detail.handleInput('\x1b[F');
    await new Promise(resolve => setTimeout(resolve, 10));
    releaseOlder({ text: 'OLDER\n', start: 7808, nextOffset: 16000, unavailableBefore: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(detail.render(80).join('\n'), /^ TAIL$/m);
    assert.doesNotMatch(detail.render(80).join('\n'), /^ OLDER$/m);
    detail.handleInput('\x1b');
    await new Promise(resolve => setTimeout(resolve, 10));
    screens.at(-1).handleInput('\x1b');
    await opened;
  } finally {
    ui.dispose();
    releaseOlder({ text: '', start: 16000, nextOffset: 16000, unavailableBefore: 0 });
  }
});

test('switching streams discards a pending page from the previous stream', async () => {
  const screens = [];
  let releaseOlder;
  const older = new Promise(resolve => {
    releaseOlder = resolve;
  });
  const task = {
    id: 'stream-task',
    title: 'Lire les flux',
    command: 'print',
    state: 'completed',
    startedAt: '2026-01-01T00:00:00Z',
    stdoutBytes: 20000,
    stderrBytes: 6,
  };
  const manager = {
    list: () => [task],
    get: () => task,
    subscribe: () => () => {},
    output: async (_id, offset, _size, stream) =>
      stream === 'stderr'
        ? { text: 'ERROR\n', start: 0, nextOffset: 6, unavailableBefore: 0 }
        : offset === undefined
          ? { text: 'TAIL\n', start: 16000, nextOffset: 20000, unavailableBefore: 0 }
          : offset < 16000
            ? older
            : { text: '', start: 20000, nextOffset: 20000, unavailableBefore: 0 },
  };
  const ctx = {
    mode: 'tui',
    ui: {
      setWidget() {},
      custom: factory =>
        new Promise(resolve => {
          screens.push(
            factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_color, text) => text }, undefined, resolve),
          );
        }),
    },
  };
  const ui = createTasksUI(ctx, manager);
  try {
    const opened = ui.open();
    screens[0].handleInput('\r');
    await new Promise(resolve => setTimeout(resolve, 10));
    const detail = screens[1];
    detail.handleInput('\x1b[H');
    detail.handleInput('\x1b[A');
    detail.handleInput('t');
    await new Promise(resolve => setTimeout(resolve, 10));
    releaseOlder({ text: 'OLD-STDOUT\n', start: 7808, nextOffset: 16000, unavailableBefore: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));
    const lines = detail.render(20);
    assert.match(lines.join('\n'), /^ ERROR$/m);
    assert.doesNotMatch(lines.join('\n'), /OLD-STDOUT/);
    assert.ok(lines.every(line => visibleWidth(line) <= 20));
    detail.handleInput('\x1b');
    await new Promise(resolve => setTimeout(resolve, 10));
    screens.at(-1).handleInput('\x1b');
    await opened;
  } finally {
    ui.dispose();
    releaseOlder({ text: '', start: 16000, nextOffset: 16000, unavailableBefore: 0 });
  }
});

async function delayedStreamDetail(t, text = 'ONE\nTWO\n') {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const screens = [];
  const requests = [];
  let release;
  const pending = new Promise(resolve => {
    release = resolve;
  });
  const page = { text, start: 0, nextOffset: Buffer.byteLength(text), unavailableBefore: 0 };
  const task = {
    id: 'delayed-task',
    title: 'Lire les logs différés',
    command: 'print',
    state: 'completed',
    startedAt: '2026-01-01T00:00:00Z',
    stdoutBytes: 7,
    stderrBytes: page.nextOffset,
  };
  const manager = {
    list: () => [task],
    get: () => task,
    subscribe: () => () => {},
    output: async (_id, offset, _size, stream) => {
      requests.push({ stream, offset });
      if (stream === 'stderr' && offset === undefined) return pending;
      if (stream === 'stdout' && offset === undefined)
        return { text: 'STDOUT\n', start: 0, nextOffset: 7, unavailableBefore: 0 };
      const end = stream === 'stdout' ? 7 : page.nextOffset;
      return { text: '', start: end, nextOffset: end, unavailableBefore: 0 };
    },
  };
  const ctx = {
    mode: 'tui',
    ui: {
      setWidget() {},
      custom: factory =>
        new Promise(resolve => {
          screens.push(
            factory(
              { terminal: { rows: 15 }, requestRender() {} },
              { fg: (_color, value) => value },
              undefined,
              resolve,
            ),
          );
        }),
    },
  };
  const ui = createTasksUI(ctx, manager);
  t.after(() => {
    ui.dispose();
    release(page);
  });
  void ui.open();
  screens[0].handleInput('\r');
  await new Promise(setImmediate);
  const detail = screens[1];
  detail.render(100);
  detail.handleInput('t');
  return { detail, requests, release: () => release(page) };
}

test('a delayed stream tail is not duplicated by the follow timer', async t => {
  const { detail, requests, release } = await delayedStreamDetail(t);
  t.mock.timers.tick(500);
  await new Promise(setImmediate);
  release();
  await new Promise(setImmediate);
  const lines = detail.render(100);
  assert.equal(lines.filter(line => line === ' ONE').length, 1);
  assert.equal(lines.filter(line => line === ' TWO').length, 1);
  assert.equal(requests.filter(request => request.stream === 'stderr' && request.offset === undefined).length, 1);
  t.mock.timers.tick(500);
  await new Promise(setImmediate);
  assert.equal(
    requests.at(-1).offset,
    Buffer.byteLength('ONE\nTWO\n'),
    'following continues from the loaded stream offset',
  );
});

test('navigation during a delayed stream load keeps the logs and the requested position', async t => {
  const text = Array.from({ length: 20 }, (_, i) => `LINE-${String(i).padStart(2, '0')}`).join('\n');
  for (const [name, navigate, firstLine] of [
    ['Up', detail => detail.handleInput('\x1b[A'), 'LINE-13'],
    ['Home', detail => detail.handleInput('\x1b[H'), 'LINE-00'],
    ['PageUp', detail => detail.handleInput('\x1b[5~'), 'LINE-08'],
    ['wheel', detail => detail.handleMouse({ type: 'wheel', wheelDelta: -2 }), 'LINE-12'],
    [
      'Home then Down',
      detail => {
        detail.handleInput('\x1b[H');
        detail.handleInput('\x1b[B');
      },
      'LINE-01',
    ],
    [
      'End then Home',
      detail => {
        detail.handleInput('\x1b[F');
        detail.handleInput('\x1b[H');
      },
      'LINE-00',
    ],
  ]) {
    await t.test(name, async t => {
      const { detail, release } = await delayedStreamDetail(t, text);
      navigate(detail);
      t.mock.timers.tick(500);
      await new Promise(setImmediate);
      release();
      await new Promise(setImmediate);
      const lines = detail.render(100);
      assert.equal(lines[6], ` ${firstLine}`);
      const paused = lines.join('\n');
      t.mock.timers.tick(1000);
      await new Promise(setImmediate);
      assert.equal(detail.render(100).join('\n'), paused, 'navigation pauses following even if loading finishes later');
    });
  }
});

test('switching back before a delayed stream load finishes keeps only the latest stream', async t => {
  const { detail, release } = await delayedStreamDetail(t);
  detail.handleInput('t'); // back to stdout while stderr is still loading
  await new Promise(setImmediate);
  release();
  await new Promise(setImmediate);
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  const text = detail.render(100).join('\n');
  assert.match(text, /^ STDOUT$/m);
  assert.doesNotMatch(text, /^ ONE$|^ TWO$/m);
});

test('session replacement stops live tasks and removes their logs', async () => {
  const h = harness();
  await h.fire('session_start', {}, h.ctx);
  const task = JSON.parse(
    (await h.call('task_start', { command: command('setInterval(() => {}, 1000)'), resume: true })).content[0].text,
  );
  await h.fire('session_shutdown', { reason: 'resume' }, h.ctx);
  assert.equal(h.messages.length, 0);
  await assert.rejects(h.call('task_status', { id: task.id }), /No active task session/);
  await h.fire('session_start', {}, h.ctx);
  try {
    const list = JSON.parse((await h.call('task_status', {})).content[0].text);
    assert.deepEqual(list, { tasks: [], total: 0, nextOffset: null });
  } finally {
    await h.fire('session_shutdown', {}, h.ctx);
  }
});
