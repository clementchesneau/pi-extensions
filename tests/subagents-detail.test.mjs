import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import { createSubagentUI } from '../packages/subagents/ui.js';
import { transcriptMessages } from '../packages/subagents/transcript.js';
import * as sdk from '@earendil-works/pi-coding-agent';
sdk.initTheme('dark');

const tick = () => new Promise(resolve => setImmediate(resolve));
const entry = text => JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';

async function detail(
  t,
  {
    runs,
    transcript = async ({ cursor = 0 }) => ({ text: entry('TOTAL_ACTIVITY').slice(cursor) }),
    result = async () => ({ text: 'LATEST_ANSWER' }),
    rows = 40,
    activitySnapshot,
    hostSdk = sdk,
  } = {},
) {
  const agent = {
    agentId: 'id',
    alias: 'A1',
    title: 'Test',
    task: 'INITIAL_MISSION',
    context: 'INITIAL_CONTEXT',
    model: { provider: 'test', id: 'model' },
    tools: ['read'],
    runs: runs ?? [{ runId: 'r1', state: 'completed' }],
  };
  agent.run = agent.runs.at(-1);
  const listeners = new Set();
  const activityListeners = new Set();
  let component;
  const terminal = { rows };
  const ui = createSubagentUI({
    sdk: hostSdk,
    ctx: {
      mode: 'tui',
      ui: {
        setWidget() {},
        custom: factory =>
          new Promise(resolve => {
            component = factory({ terminal, requestRender() {} }, { fg: (_name, text) => text }, {}, resolve);
          }),
      },
    },
    manager: {
      compactAgents: () => [agent],
      findAgent: () => agent,
      activeAgentIds: () => [],
      subscribe: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeActivity: listener => {
        activityListeners.add(listener);
        return () => activityListeners.delete(listener);
      },
      activitySnapshot,
      transcript,
      result,
    },
    getConfig: async () => ({ maxConcurrent: 4 }),
  });
  const opened = ui.open();
  t.after(async () => {
    ui.dispose();
    await opened;
  });
  component.handleInput('\r');
  await tick();
  return {
    agent,
    render: (width = 80) => component.render(width).map(stripVTControlCharacters),
    key: key => component.handleInput(key),
    resize: rows => {
      terminal.rows = rows;
    },
    notify: () => {
      for (const listener of listeners) listener({ agentId: 'id', state: agent.run.state });
    },
    activity: data => {
      for (const listener of activityListeners) listener({ agentId: 'id', runId: agent.run.runId, data });
    },
  };
}

test('detail keeps the status on the title row when it fits, otherwise gives it its own row', async t => {
  const view = await detail(t);
  const wide = view.render(100);
  assert.match(wide[1], /A1 {2}Test.*completed/);
  assert.doesNotMatch(wide[2], /^ completed$/);
  const narrow = view.render(12);
  assert.match(narrow[1], /A1 {2}Test/);
  assert.match(narrow[2], /completed/);
  assert.ok(narrow.every(line => visibleWidth(line) <= 12));
});

test('response preserves multiline Markdown structure while removing terminal controls', async t => {
  const view = await detail(t, {
    result: async () => ({
      text: '## Bilan\n\n- **fait**\n- suite\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\u001b[31mfin',
    }),
  });
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push(...view.render());
    view.key('\x1b[B');
  }
  assert.ok(
    rows.some(row => /Bilan/.test(row) && !/fait|suite/.test(row)),
    'heading has its own row',
  );
  assert.ok(
    rows.some(row => /fait/.test(row) && !/suite/.test(row)),
    'list items remain separate',
  );
  assert.ok(rows.some(row => /suite/.test(row) && !/fait/.test(row)));
  assert.ok(
    rows.some(row => /const x = 1;/.test(row) && !/const y = 2;/.test(row)),
    'code lines remain separate',
  );
  assert.ok(rows.some(row => /const y = 2;/.test(row)));
  assert.doesNotMatch(rows.join('\n'), /## Bilan|\*\*fait\*\*|\u001b\[31m/);
});

test('dense numbered responses become legible lists in a bounded reading column', async t => {
  const view = await detail(t, {
    result: async () => ({
      text: 'Voici les risques : 1. Premier risque avec explication. 2. Second risque avec explication. 3. Dernier risque.',
    }),
  });
  const all = [];
  for (let i = 0; i < 12; i++) {
    all.push(...view.render(180));
    view.key('\x1b[B');
  }
  const text = all.join('\n');
  assert.match(text, /Premier risque/);
  assert.match(text, /Second risque/);
  assert.match(text, /Dernier risque/);
  assert.ok(
    all.some(line => /^\s*1\.\s+Premier risque/.test(line)),
    'each inline item should start its own list row',
  );
  assert.ok(all.some(line => /^\s*2\.\s+Second risque/.test(line)));
  assert.ok(
    all
      .filter(line => /Premier risque|Second risque|Dernier risque/.test(line))
      .every(line => visibleWidth(line) <= 104),
  );
});

test('existing fenced code and ordinary numbered prose stay unchanged', async t => {
  const view = await detail(t, {
    result: async () => ({ text: 'Étape 1. Terminé.\n\n```text\n1. alpha 2. beta\n```' }),
  });
  const output = view.render(100).join('\n');
  assert.match(output, /Étape 1\. Terminé/);
  assert.match(output, /1\. alpha 2\. beta/);
});

test('header separates agent identity from tabs on normal-height terminals', async t => {
  const view = await detail(t);
  const rows = view.render(80);
  assert.match(rows[1], /A1/);
  assert.equal(rows[2], '');
  assert.match(rows[3], /r Response/);
});

test('activity parsing retains native messages and tool call arguments', () => {
  const message = value => JSON.stringify({ message: value });
  const messages = transcriptMessages(
    [
      message({
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'read', arguments: { path: 'src/main.js', offset: 10 } }],
      }),
      message({ role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'first line\nsecond line' }] }),
      message({ role: 'assistant', content: [{ type: 'text', text: 'Conclusion' }] }),
      message({ role: 'user', content: [{ type: 'text', text: 'Focus on tests' }] }),
      message({ role: 'toolResult', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'failed' }] }),
    ].join('\n'),
  );
  assert.equal(messages.length, 5);
  assert.deepEqual(messages[0].content[0].arguments, { path: 'src/main.js', offset: 10 });
  assert.equal(messages[1].content[0].text, 'first line\nsecond line');
  assert.equal(messages[2].content[0].text, 'Conclusion');
  assert.equal(messages[3].role, 'user');
  assert.equal(messages[4].isError, true);
});

test('long assistant activity is scrollable without a three-row preview at narrow widths', async t => {
  const text = entry('VERY_LONG '.repeat(100));
  const view = await detail(t, { transcript: async ({ cursor = 0 }) => ({ text: text.slice(cursor) }) });
  view.key('a');
  const rows = view.render(40);
  assert.ok(rows.filter(row => row.includes('VERY_LONG')).length > 3);
  assert.doesNotMatch(rows.join('\n'), /archive/);
  assert.ok(rows.every(row => visibleWidth(row) <= 40));
  view.key('\x1b[F');
  await tick();
  assert.match(view.render(40).join('\n'), /VERY_LONG/);
});

test('information omits selection provenance while keeping the effective configuration', async t => {
  const view = await detail(t);
  view.agent.thinkingLevel = 'medium';
  view.key('i');
  for (const selectionSource of [
    { model: 'specified', reasoning: 'specified', tools: 'specified' },
    { model: 'hérité', reasoning: 'défini', tools: 'hérités' },
    undefined,
  ]) {
    view.agent.selectionSource = selectionSource;
    const info = view.render(100).join('\n');
    assert.doesNotMatch(info, /Selection:/);
    assert.match(info, /Model: test\/model · reasoning: medium/);
    assert.match(info, /Tools: read/);
    assert.deepEqual(view.agent.selectionSource, selectionSource);
  }
});

test('information avoids the initial instruction duplicate while keeping follow-ups', async t => {
  const view = await detail(t, {
    runs: [
      {
        runId: 'r1',
        state: 'completed',
        instructions: ['INITIAL_MISSION', 'EXTRA_INSTRUCTION'],
        usage: { totalTokens: 60095, cost: { total: 0.00412006 } },
      },
    ],
  });
  view.key('i');
  let text = view.render(160).join('\n');
  assert.equal((text.match(/INITIAL_MISSION/g) ?? []).length, 1);
  for (let i = 0; i < 30; i++) {
    view.key('\x1b[B');
    text += view.render(160).join('\n');
  }
  assert.match(text, /Initial mission above/);
  assert.match(text, /EXTRA_INSTRUCTION/);
  assert.match(text, /60,095 tokens/);
  assert.match(text, /\$0\.00412/);
  assert.doesNotMatch(text, /Reported usage/);
});

test('detail has separate response, total activity and global/per-execution information', async t => {
  const view = await detail(t, {
    runs: [
      {
        runId: 'r1',
        state: 'completed',
        instructions: ['FIRST_INSTRUCTION', 'ADDITIONAL_INSTRUCTION'],
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:00:10Z',
        usage: { totalTokens: 12, cost: { total: 0.01 } },
      },
      {
        runId: 'r2',
        state: 'completed',
        instructions: ['FOLLOW_UP'],
        startedAt: '2026-01-01T00:01:00Z',
        finishedAt: '2026-01-01T00:01:20Z',
        usage: { totalTokens: 23, cost: { total: 0.02 } },
      },
    ],
  });
  assert.match(view.render().join('\n'), /LATEST_ANSWER/);
  assert.doesNotMatch(view.render().join('\n'), /TOTAL_ACTIVITY|INITIAL_MISSION|20s/);
  view.key('a');
  assert.match(view.render().join('\n'), /TOTAL_ACTIVITY/);
  assert.doesNotMatch(view.render().join('\n'), /LATEST_ANSWER|INITIAL_MISSION/);
  view.key('i');
  let info = view.render().join('\n');
  for (let i = 0; i < 45; i++) {
    view.key('\x1b[B');
    info += '\n' + view.render().join('\n');
  }
  for (const expected of [
    /Total duration: 30s/,
    /INITIAL_MISSION/,
    /INITIAL_CONTEXT/,
    /35 tokens/,
    /Run 1/,
    /FIRST_INSTRUCTION/,
    /ADDITIONAL_INSTRUCTION/,
    /10s/,
    /12 tokens/,
    /Run 2/,
    /FOLLOW_UP/,
    /20s/,
    /23 tokens/,
  ])
    assert.match(info, expected);
  assert.doesNotMatch(info, /LATEST_ANSWER|TOTAL_ACTIVITY/);
});

test('short terminals keep each view bounded and expose only available actions', async t => {
  const view = await detail(t, { rows: 24 });
  for (const key of ['r', 'a', 'i']) {
    view.key(key);
    const lines = view.render(40);
    assert.equal(lines.length, 24);
    assert.ok(lines.every(line => visibleWidth(line) <= 40));
    assert.doesNotMatch(lines.join(' '), /s stop|n page|next result/);
  }
});

test('scrolling loads response and activity pages without manual pagination keys', async t => {
  const resultCursors = [],
    transcriptCursors = [];
  const view = await detail(t, {
    result: async ({ cursor }) => {
      resultCursors.push(cursor);
      return cursor === undefined
        ? { text: Array.from({ length: 25 }, (_, i) => `answer-${i}`).join('\n'), nextCursor: 100 }
        : { text: '\nANSWER_TAIL', nextCursor: undefined };
    },
    transcript: async ({ cursor }) => {
      transcriptCursors.push(cursor);
      return cursor === 0
        ? { text: Array.from({ length: 25 }, (_, i) => entry(`activity-${i}`)).join(''), nextCursor: 200 }
        : { text: entry('ACTIVITY_TAIL'), nextCursor: undefined };
    },
  });
  view.render();
  for (let i = 0; i < 35; i++) {
    view.key('\x1b[B');
    await tick();
    view.render();
  }
  assert.match(view.render().join('\n'), /ANSWER_TAIL/);
  assert.deepEqual(resultCursors, [undefined, 100]);
  view.key('a');
  view.render();
  for (let i = 0; i < 35; i++) {
    view.key('\x1b[B');
    await tick();
    view.render();
  }
  assert.match(view.render().join('\n'), /ACTIVITY_TAIL/);
  assert.ok(transcriptCursors.includes(200));
});

test('older executions without recorded instructions are explicit, not reconstructed', async t => {
  const view = await detail(t, { runs: [{ runId: 'old', state: 'completed' }] });
  view.key('i');
  let text = '';
  for (let i = 0; i < 30; i++) {
    text += view.render().join('\n');
    view.key('\x1b[B');
  }
  assert.match(text, /Instructions unavailable/);
  assert.match(text, /Usage unavailable/);
});

test('events during historical activity pagination never skip the newly loaded page', async t => {
  let release;
  const view = await detail(t, {
    runs: [{ runId: 'r1', state: 'running' }],
    transcript: async ({ cursor }) =>
      cursor === 0
        ? { text: Array.from({ length: 25 }, (_, i) => entry(`FIRST-${i}`)).join(''), nextCursor: 200 }
        : cursor === 200
          ? new Promise(resolve => {
              release = () =>
                resolve({
                  text: Array.from({ length: 30 }, (_, i) => entry(`SECOND-${i}`)).join(''),
                  nextCursor: 400,
                });
            })
          : { text: entry('THIRD'), nextCursor: undefined },
  });
  view.key('\x1b[H');
  view.render();
  for (let i = 0; i < 60; i++) view.key('\x1b[B');
  await tick();
  assert.equal(typeof release, 'function');
  const firstVisible = view.render().find(line => line.includes('FIRST-'));
  assert.ok(firstVisible);
  view.notify();
  release();
  await tick();
  assert.equal(
    view.render().find(line => line.includes('FIRST-')),
    firstVisible,
  );
  let displayed = '';
  for (let i = 0; i < 60; i++) {
    displayed += view.render().join('\n');
    view.key('\x1b[B');
  }
  assert.match(displayed, /SECOND-0/);
});

test('live text during historical pagination cannot reactivate following or skip entries', async t => {
  let release;
  const view = await detail(t, {
    runs: [{ runId: 'r1', state: 'running' }],
    transcript: async ({ cursor }) =>
      cursor === 0
        ? { text: Array.from({ length: 25 }, (_, i) => entry(`FIRST-${i}`)).join(''), nextCursor: 200 }
        : cursor === 200
          ? new Promise(resolve => {
              release = () =>
                resolve({
                  text: Array.from({ length: 30 }, (_, i) => entry(`SECOND-${i}`)).join(''),
                  nextCursor: 400,
                });
            })
          : { text: entry('THIRD'), nextCursor: undefined },
  });
  view.key('\x1b[H');
  view.render();
  for (let i = 0; i < 60; i++) view.key('\x1b[B');
  await tick();
  assert.equal(typeof release, 'function');
  const firstVisible = view.render().find(line => line.includes('FIRST-'));
  assert.match(firstVisible, /FIRST-/);
  view.activity({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'LIVE' },
  });
  release();
  await tick();
  assert.equal(
    view.render().find(line => line.includes('FIRST-')),
    firstVisible,
  );
  let displayed = '';
  for (let i = 0; i < 60; i++) {
    displayed += view.render().join('\n');
    view.key('\x1b[B');
  }
  assert.match(displayed, /SECOND-0\s/);
});

test('initial live following cannot bypass pagination guards when a refresh exposes historical pages', async t => {
  let archive = Array.from({ length: 7 }, (_, i) => entry(`entry-${i}`)).join('');
  const view = await detail(t, {
    rows: 12,
    runs: [{ runId: 'r1', state: 'running' }],
    transcript: async ({ cursor = 0, maxBytes }) => {
      const bytes = Buffer.from(archive);
      const end = Math.min(cursor + maxBytes, bytes.length);
      return { text: bytes.subarray(cursor, end).toString(), nextCursor: end < bytes.length ? end : undefined };
    },
  });
  view.key('\x1b[H');
  const firstVisible = view.render(80).find(line => line.includes('entry-'));
  assert.equal(firstVisible.trim(), 'entry-0');
  archive += Array.from({ length: 150 }, (_, i) => entry(`entry-${i + 7}`)).join('');
  view.notify();
  await tick();
  view.activity({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'LIVE-TAIL' },
  });
  assert.equal(
    view.render(80).find(line => line.includes('entry-')),
    firstVisible,
  );
  view.key('\x1b[F');
  await tick();
  assert.match(view.render(80).join('\n'), /entry-156/);
  assert.match(view.render(80).join('\n'), /LIVE-TAIL/);
});

test('initial short activity follows progressively archived entries without navigation in an 80×12 terminal', async t => {
  let archive = entry('entry-0');
  const view = await detail(t, {
    rows: 12,
    runs: [{ runId: 'r1', state: 'running' }],
    transcript: async ({ cursor = 0 }) => ({ text: archive.slice(cursor), nextCursor: undefined }),
  });
  assert.match(view.render(80).join('\n'), /entry-0/);
  for (let i = 1; i <= 14; i++) {
    archive += entry(`entry-${i}`);
    view.notify();
    await tick();
    assert.match(
      view.render(80).join('\n'),
      new RegExp(`entry-${i}(?:\\s|$)`),
      `entry ${i} must stay visible without navigation`,
    );
  }
});

for (const scenario of [
  { name: 'empty initial activity', initial: 0, follows: true },
  { name: 'initial activity almost fills the viewport', initial: 3, follows: true },
  { name: 'initial activity exceeds the viewport', initial: 8, follows: true },
  { name: 'Home before initial layout', initial: 3, keyBefore: '\x1b[H', follows: false },
  { name: 'Up while initial activity still fits', initial: 3, keyAfter: '\x1b[A', follows: false },
]) {
  test(`live following respects ${scenario.name}`, async t => {
    const archive = Array.from({ length: scenario.initial }, (_, i) => entry(`entry-${i}`)).join('');
    const view = await detail(t, {
      rows: 12,
      runs: [{ runId: 'r1', state: 'running' }],
      transcript: async ({ cursor = 0 }) => ({ text: archive.slice(cursor), nextCursor: undefined }),
    });
    if (scenario.keyBefore) view.key(scenario.keyBefore);
    view.render(80);
    if (scenario.keyAfter) view.key(scenario.keyAfter);
    for (let i = 0; i <= 14; i++) {
      view.activity({ type: 'tool_execution_start', toolCallId: `call-${i}`, toolName: `tool-${i}` });
      const rendered = view.render(80);
      if (scenario.follows) assert.match(rendered.join('\n'), new RegExp(`tool-${i}(?:\\s|$)`));
      else assert.equal(rendered.find(line => line.includes('entry-'))?.trim(), 'entry-0');
    }
    if (!scenario.follows) assert.doesNotMatch(view.render(80).join('\n'), /tool-14/);
  });
}

test('End follows live and archived updates but Home prevents live events from restoring following', async t => {
  let archive = Array.from({ length: 60 }, (_, i) => entry(`history-${i}`)).join('');
  const view = await detail(t, {
    runs: [{ runId: 'r1', state: 'running' }],
    transcript: async ({ cursor = 0 }) => ({ text: archive.slice(cursor), nextCursor: undefined }),
  });
  view.render();
  view.key('\x1b[F');
  await tick();
  assert.match(view.render().join('\n'), /history-59/);
  view.activity({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'LIVE-TAIL' },
  });
  assert.match(view.render().join('\n'), /LIVE-TAIL/);
  view.activity({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'LIVE-TAIL' }] },
  });
  archive += entry('LIVE-TAIL') + entry('ARCHIVED-TAIL');
  view.notify();
  await tick();
  assert.match(view.render().join('\n'), /ARCHIVED-TAIL/);
  view.key('\x1b[H');
  view.resize(100);
  assert.match(view.render().join('\n'), /history-0\s/);
  view.activity({ type: 'message_start', message: { role: 'assistant' } });
  view.activity({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'EXTRA-TAIL' },
  });
  view.resize(24);
  assert.equal(
    view
      .render()
      .find(line => line.includes('history-'))
      ?.trim(),
    'history-0',
  );
  view.key('\x1b[F');
  await tick();
  assert.match(view.render().join('\n'), /EXTRA-TAIL/);
});

test('active detail shows streamed text and tool status without leaking reasoning or duplicating archived text', async t => {
  let archive = '';
  const view = await detail(t, {
    runs: [{ runId: 'r1', state: 'running' }],
    transcript: async ({ cursor = 0 }) => ({ text: archive.slice(cursor) }),
  });
  view.render();
  view.activity({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'SECRET' },
  });
  view.activity({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Bonjour ' },
  });
  view.activity({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'en direct' },
  });
  assert.match(view.render().join('\n'), /Bonjour en direct/);
  assert.doesNotMatch(view.render().join('\n'), /SECRET/);
  view.activity({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: 'x' } });
  assert.match(view.render().join('\n'), /read.*x/);
  view.activity({
    type: 'tool_execution_end',
    toolCallId: 'c1',
    toolName: 'read',
    result: { content: [{ type: 'text', text: 'ok' }] },
    isError: false,
  });
  view.key('\x0f');
  assert.match(view.render().join('\n'), /ok/);
  archive =
    entry('Bonjour en direct') +
    JSON.stringify({
      message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'ok' }] },
    }) +
    '\n';
  view.activity({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Bonjour en direct' }] },
  });
  view.notify();
  await tick();
  await tick();
  const rendered = view.render().join('\n');
  assert.equal((rendered.match(/Bonjour en direct/g) ?? []).length, 1);
  assert.equal((rendered.match(/ok/g) ?? []).length, 1);
});

test('a tool completion disappears once archived even when the activity window evicts older lines', async t => {
  let archive = Array.from({ length: 600 }, (_, i) => entry(`older-${i}`)).join('');
  const view = await detail(t, {
    runs: [{ runId: 'r1', state: 'running' }],
    transcript: async ({ cursor = 0 }) => ({ text: archive.slice(cursor) }),
  });
  view.render();
  view.activity({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read' });
  view.activity({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', isError: false });
  archive +=
    JSON.stringify({
      message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'ok' }] },
    }) + '\n';
  view.notify();
  await tick();
  await tick();
  view.key('\x0f');
  view.key('\x1b[F');
  await tick();
  const rendered = view.render().join('\n');
  assert.match(rendered, /ok/);
  assert.equal((rendered.match(/\bread\b/g) ?? []).length, 1);
});

test('active transcript catches up without metadata events after the stream settles', async t => {
  let archive = '';
  const view = await detail(t, {
    runs: [{ runId: 'r1', state: 'running' }],
    transcript: async ({ cursor = 0 }) => ({ text: archive.slice(cursor) }),
  });
  view.render();
  archive = entry('persisted later');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.match(view.render().join('\n'), /persisted later/);
});

test('new live activity does not pull the reader away from older lines', async t => {
  const view = await detail(t, {
    runs: [{ runId: 'r1', state: 'running' }],
    transcript: async ({ cursor = 0 }) => ({
      text: Array.from({ length: 60 }, (_, i) => entry(`history-${i}`))
        .join('')
        .slice(cursor),
    }),
  });
  view.key('\x1b[H');
  view.render();
  for (let i = 0; i < 30; i++) view.key('\x1b[B');
  view.render();
  view.key('\x1b[A');
  const before = view.render().find(line => line.includes('history-'));
  assert.ok(before);
  view.activity({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'new text' },
  });
  assert.equal(
    view.render().find(line => line.includes('history-')),
    before,
  );
  for (let i = 0; i < 120; i++) view.key('\x1b[B');
  assert.match(view.render().join('\n'), /new text/);
});

test('active details fit very short and narrow terminals with usable navigation', async t => {
  for (const [width, rows] of [
    [20, 16],
    [40, 20],
  ]) {
    const view = await detail(t, { rows, runs: [{ runId: 'r1', state: 'running', instructions: ['WORK'] }] });
    for (const key of ['r', 'a', 'i']) {
      view.key(key);
      const lines = view.render(width);
      assert.equal(lines.length, rows, `${width}×${rows}: overlay must cover the whole terminal`);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.match(lines.join(' '), /s stop/);
    }
  }
});

test('activity uses host native components and retains long multiline assistant and tool output', async t => {
  const constructed = [];
  const hostSdk = { ...sdk };
  for (const name of ['AssistantMessageComponent', 'UserMessageComponent', 'ToolExecutionComponent']) {
    hostSdk[name] = class extends sdk[name] {
      constructor(...args) {
        super(...args);
        constructed.push(name);
      }
    };
  }
  const messages = [
    { role: 'user', content: 'PARENT_INSTRUCTION' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'ASSISTANT_BEGIN\n' + 'long text '.repeat(200) + '\nASSISTANT_END' },
        { type: 'toolCall', id: 'c1', name: 'custom_tool', arguments: { path: 'x' } },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'custom_tool',
      content: [{ type: 'text', text: 'TOOL_BEGIN\n' + 'output\n'.repeat(20) + 'TOOL_END' }],
    },
  ];
  const archive = messages.map(message => JSON.stringify({ message }) + '\n').join('');
  const view = await detail(t, { hostSdk, transcript: async ({ cursor = 0 }) => ({ text: archive.slice(cursor) }) });
  view.key('a');
  view.key('\x0f'); // Native tool expansion (Ctrl+O).
  let text = '';
  for (let i = 0; i < 160; i++) {
    text += view.render(40).join('\n') + '\n';
    view.key('\x1b[B');
  }
  for (const expected of ['PARENT_INSTRUCTION', 'ASSISTANT_BEGIN', 'ASSISTANT_END', 'TOOL_BEGIN', 'TOOL_END'])
    assert.ok(text.includes(expected), expected);
  assert.ok(constructed.includes('AssistantMessageComponent'));
  assert.ok(constructed.includes('UserMessageComponent'));
  assert.ok(constructed.includes('ToolExecutionComponent'));
  assert.doesNotMatch(text, /truncated; full archive|… \[archive\]/);
});

test('opening receives a snapshot and events during the initial archive read without polling deltas', async t => {
  let release;
  let reads = 0;
  const finished = { role: 'assistant', timestamp: 123, content: [{ type: 'text', text: 'SNAPSHOT_FINAL' }] };
  const view = await detail(t, {
    runs: [{ runId: 'r1', state: 'running' }],
    activitySnapshot: () => ({
      runId: 'r1',
      messages: [finished],
      message: { role: 'assistant', timestamp: 124, content: [{ type: 'text', text: 'LIVE_BEGIN\n' }] },
      tools: [],
    }),
    transcript: async () => {
      reads++;
      return reads === 1
        ? new Promise(resolve => {
            release = () => resolve({ text: JSON.stringify({ message: finished }) + '\n' });
          })
        : { text: '' };
    },
  });
  view.activity({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'DURING_READ\n' },
  });
  release();
  await tick();
  await tick();
  const output = view.render().join('\n');
  assert.equal((output.match(/SNAPSHOT_FINAL/g) ?? []).length, 1);
  assert.match(output, /LIVE_BEGIN/);
  assert.match(output, /DURING_READ/);
  assert.ok(
    view.render().some(row => row.includes('LIVE_BEGIN') && !row.includes('DURING_READ')),
    'streamed newlines stay distinct',
  );
  const baseline = reads;
  for (let i = 0; i < 12; i++) {
    view.activity({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'more\n' },
    });
    view.notify(); // Usage metadata may also change on each streamed delta.
  }
  await tick();
  assert.equal(reads, baseline, 'stream deltas do not read archive');
});

test('continuation during initial archive loading replaces stale live state and keeps new activity', async t => {
  let release;
  let snapshot = { runId: 'r1', messages: [], tools: [{ toolCallId: 'old', toolName: 'OLD_TOOL', args: {} }] };
  const view = await detail(t, {
    runs: [{ runId: 'r1', state: 'running' }],
    activitySnapshot: () => snapshot,
    transcript: async () =>
      new Promise(resolve => {
        release = () => resolve({ text: entry('ARCHIVE_HISTORY') });
      }),
  });
  view.activity({ type: 'tool_execution_start', toolCallId: 'buffered-old', toolName: 'OLD_BUFFERED_TOOL' });
  view.agent.run = { runId: 'r2', state: 'running' };
  view.agent.runs.push(view.agent.run);
  snapshot = {
    runId: 'r2',
    messages: [],
    tools: [],
    message: { role: 'assistant', content: [{ type: 'text', text: 'NEW_SNAPSHOT\nNEW_ACTIVITY' }] },
  };
  view.notify();
  view.activity({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'NEW_ACTIVITY' },
  });
  release();
  await tick();
  await tick();
  const output = view.render().join('\n');
  assert.match(output, /NEW_SNAPSHOT/);
  assert.equal((output.match(/NEW_ACTIVITY/g) ?? []).length, 1, 'snapshot-covered events are not replayed twice');
  assert.match(output, /ARCHIVE_HISTORY/);
  assert.doesNotMatch(output, /OLD_TOOL|OLD_BUFFERED_TOOL/);
  view.activity({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '\nAFTER_OPEN' },
  });
  assert.match(view.render().join('\n'), /AFTER_OPEN/);
  view.key('r');
  assert.match(view.render().join('\n'), /Final response pending/);
  view.key('i');
  assert.match(view.render().join('\n'), /INITIAL_MISSION/);
});

for (const phase of ['archive', 'result'])
  test(`continuation during initial ${phase} loading preserves the preceding run final message`, async t => {
    let releaseArchive;
    let releaseResult;
    let archive = '';
    let reads = 0;
    let snapshot = {
      runId: 'r1',
      messages: [],
      tools: [{ toolCallId: 'old', toolName: 'OLD_TOOL', args: {} }],
      message: { role: 'assistant', content: [{ type: 'text', text: 'OLD_PARTIAL' }] },
    };
    const view = await detail(t, {
      runs: [{ runId: 'r1', state: 'running' }],
      activitySnapshot: () => snapshot,
      transcript: async ({ cursor = 0 }) =>
        ++reads === 1
          ? new Promise(resolve => {
              releaseArchive = () => resolve({ text: '' });
            })
          : { text: archive.slice(cursor) },
      result: async ({ runId }) =>
        runId === 'r1'
          ? new Promise(resolve => {
              releaseResult = () => resolve({ text: 'OLD_RESPONSE' });
            })
          : { text: 'NEW_RESPONSE' },
    });
    const final = { role: 'assistant', timestamp: 1, content: [{ type: 'text', text: 'OLD_FINAL' }] };
    view.activity({ type: 'message_end', message: final });
    if (phase === 'result') {
      view.agent.run.state = 'completed';
      view.notify();
      releaseArchive();
      await tick();
      assert.ok(releaseResult, 'initial result read is gated');
    }
    view.agent.run = { runId: 'r2', state: 'running' };
    view.agent.runs.push(view.agent.run);
    snapshot = {
      runId: 'r2',
      messages: [],
      tools: [],
      message: { role: 'assistant', timestamp: 2, content: [{ type: 'text', text: 'NEW_LIVE\nNEW_DELTA' }] },
    };
    view.notify();
    view.activity({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '\nNEW_DELTA' },
    });
    if (phase === 'archive') releaseArchive();
    else releaseResult();
    await tick();
    await tick();
    view.key('a');
    let output = view.render().join('\n');
    assert.equal(
      (output.match(/OLD_FINAL/g) ?? []).length,
      1,
      'the new snapshot must not discard the buffered old final',
    );
    assert.equal((output.match(/NEW_DELTA/g) ?? []).length, 1, 'new snapshot-covered deltas must not be replayed');
    assert.match(output, /NEW_LIVE/);
    assert.doesNotMatch(output, /OLD_PARTIAL|OLD_TOOL/);
    archive = JSON.stringify({ message: final }) + '\n';
    view.agent.run.state = 'completed';
    view.notify();
    await tick();
    await tick();
    output = view.render().join('\n');
    assert.equal(
      (output.match(/OLD_FINAL/g) ?? []).length,
      1,
      'archive catch-up must not duplicate the preserved old final',
    );
  });

test('continuations during initial and replacement result reads install the latest snapshot', async t => {
  const releases = new Map();
  let snapshot = { runId: 'r1', messages: [], tools: [{ toolCallId: 'old', toolName: 'OLD_TOOL', args: {} }] };
  const view = await detail(t, {
    activitySnapshot: () => snapshot,
    transcript: async ({ cursor = 0 }) => ({ text: entry('ARCHIVE_HISTORY').slice(cursor) }),
    result: async ({ runId }) =>
      runId === 'r3'
        ? { text: 'LATEST_RESULT' }
        : new Promise(resolve => {
            releases.set(runId, () => resolve({ text: `STALE_RESULT_${runId}` }));
          }),
  });
  const continueRun = runId => {
    view.agent.run = { runId, state: 'completed' };
    view.agent.runs.push(view.agent.run);
    snapshot = {
      runId,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: `SNAPSHOT_${runId}` }] }],
      tools: [{ toolCallId: `buffered-${runId}`, toolName: `NEW_TOOL_${runId}`, args: {} }],
    };
    view.notify();
    view.activity({ type: 'tool_execution_start', toolCallId: `buffered-${runId}`, toolName: `NEW_TOOL_${runId}` });
  };
  assert.ok(releases.has('r1'), 'initial result read is gated');
  continueRun('r2');
  releases.get('r1')();
  await tick();
  assert.ok(releases.has('r2'), 'replacement result read is also gated');
  continueRun('r3');
  releases.get('r2')();
  await tick();
  await tick();
  assert.match(view.render().join('\n'), /LATEST_RESULT/);
  assert.doesNotMatch(view.render().join('\n'), /STALE_RESULT/);
  view.key('a');
  const output = view.render().join('\n');
  assert.match(output, /SNAPSHOT_r3/);
  assert.match(output, /ARCHIVE_HISTORY/);
  assert.doesNotMatch(output, /OLD_TOOL|NEW_TOOL_r2/);
  assert.equal(
    (output.match(/NEW_TOOL_r3/g) ?? []).length,
    1,
    'new-run tool activity survives snapshot reconciliation',
  );
  view.activity({ type: 'tool_execution_start', toolCallId: 'fresh', toolName: 'NEW_TOOL' });
  assert.match(view.render().join('\n'), /NEW_TOOL/);
  view.key('i');
  assert.match(view.render().join('\n'), /INITIAL_MISSION/);
});

test('native tools use the expansion shortcut instead of a fixed custom output preview', async t => {
  const output =
    JSON.stringify({
      message: {
        role: 'toolResult',
        toolCallId: 'c',
        toolName: 'custom',
        content: [{ type: 'text', text: 'line\n'.repeat(20) + 'EXPANDED_END' }],
      },
    }) + '\n';
  const view = await detail(t, { transcript: async ({ cursor = 0 }) => ({ text: output.slice(cursor) }) });
  view.key('a');
  assert.doesNotMatch(view.render().join('\n'), /EXPANDED_END/);
  view.key('\x0f');
  view.key('\x1b[F');
  await tick();
  assert.match(view.render().join('\n'), /EXPANDED_END/);
  view.key('\x0f');
  assert.doesNotMatch(view.render().join('\n'), /EXPANDED_END/);
});
