import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { cumulativeDuration, formatStatus, usageSummary } from '../packages/subagents/format.js';
import { createSubagentUI } from '../packages/subagents/ui.js';
import { ActivityTranscript, transcriptMessages } from '../packages/subagents/transcript.js';
import { registerSubagentRenderers } from '../packages/subagents/renderers.js';
import subagentsExtension from '../packages/subagents/index.js';
import * as parentSdk from '@earendil-works/pi-coding-agent';
import graphiteUi from '../packages/graphite-ui/index.js';
import { SubagentStore } from '../packages/subagents/store.js';
import { DEFAULT_SUBAGENT_CONFIG, loadSubagentConfig } from '../packages/subagents/config.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import { singleLineText } from '../packages/shared/terminal-text.js';
import { createFakePi } from './fixtures/fake-pi.mjs';

initTheme('dark');
const transcriptRow = lines => lines.find(line => /line-\d+/u.test(line));

// Inject the SDK that owns these simulated parent sessions.
const subagents = (pi, options) => subagentsExtension(pi, { sdk: parentSdk, ...options });
const agent = (alias, state, title = 'Mission') => ({
  agentId: `id-${alias}`,
  alias,
  title,
  run: { state, startedAt: '2025-01-01T00:00:00Z', activity: 'tool: read' },
});

test('status is bounded, prioritizes active agents and omits archived missions', () => {
  const agents = [
    agent('A1', 'completed'),
    ...Array.from({ length: 8 }, (_, i) => agent(`A${i + 2}`, 'running', 'Long 🐈 title '.repeat(20))),
  ];
  for (const width of [0, 1, 20, 40, 80, 120]) {
    const lines = formatStatus(agents, { maxConcurrent: 9, now: Date.parse('2025-01-01T00:01:00Z') }, width);
    assert.ok(lines.length <= 7);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    if (width >= 40) {
      assert.match(lines[0], /\/subagents/);
      assert.match(lines.join(' '), /A2/);
      assert.doesNotMatch(lines.join(' '), /A1/);
    }
  }
});

test('cumulative duration includes live runs, sums before rounding and rejects incomplete history', () => {
  const finished = { state: 'completed', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:00.600Z' };
  const live = { state: 'running', startedAt: '2026-01-02T00:00:00Z' };
  assert.equal(cumulativeDuration({ runs: [finished, live], run: live }, Date.parse('2026-01-02T00:00:01.500Z')), '2s');
  assert.equal(cumulativeDuration({ run: finished }), '0s');
  assert.equal(
    cumulativeDuration({ runs: [finished, { state: 'completed', startedAt: live.startedAt }] }),
    'duration unavailable',
  );
  assert.equal(cumulativeDuration({ runs: [{ state: 'running' }] }), 'duration unavailable');
  assert.equal(cumulativeDuration({ runs: [] }), 'duration unavailable');
});

test('usage distinguishes latest run from reported cumulative totals without inventing missing cost', () => {
  const text = usageSummary({
    runs: [
      { state: 'completed', usage: { input: 10, output: 5, cost: { total: 0.01 } } },
      { state: 'completed', usage: { input: 7, output: 3 } },
    ],
  });
  assert.match(text, /Latest run:.*10 tokens/);
  assert.match(text, /Total for.*25 tokens/);
  assert.match(text, /cost unavailable/);
});

test('reported costs do not show binary floating-point artifacts', () => {
  assert.match(
    usageSummary({
      runs: [{ state: 'completed', usage: { totalTokens: 100, cost: { total: 0.041887999999999995 } } }],
    }),
    /0\.041888 USD/,
  );
});

test('terminal status does not retain a stale pending action', () => {
  const ended = agent('A1', 'cancelled');
  ended.run.activity = 'awaiting admission';
  assert.doesNotMatch(formatStatus([ended], { maxConcurrent: 2 }, 100).join(' '), /awaiting admission/);
});

test('status only includes work in progress, not completed siblings', () => {
  const lines = formatStatus([agent('A1', 'completed'), agent('A2', 'running')], { maxConcurrent: 4 }, 80);
  assert.match(lines.join(' '), /A2 in progress/);
  assert.doesNotMatch(lines.join(' '), /A1/);
});

test('status disappears when all missions are finished while archives remain accessible in the list', () => {
  const agents = Array.from({ length: 10 }, (_, index) => agent(`A${index + 1}`, 'completed'));
  assert.deepEqual(formatStatus(agents, { maxConcurrent: 4 }, 100), []);
});

test('widget only exists in TUI and clears without touching other widget ids', () => {
  const widgets = [];
  const listeners = new Set();
  let agents = [agent('A1', 'running')];
  const manager = {
    compactAgents: () => agents,
    subscribe: callback => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  const ctx = { mode: 'tui', ui: { setWidget: (...args) => widgets.push(args) } };
  const ui = createSubagentUI({ ctx, manager, getConfig: async () => ({ maxConcurrent: 4 }) });
  assert.equal(widgets.at(-1)[0], 'subagents-status');
  agents = [agent('A1', 'completed')];
  for (const listener of listeners) listener({});
  assert.deepEqual(widgets.at(-1), ['subagents-status', undefined]);
  agents = [];
  for (const listener of listeners) listener({});
  assert.deepEqual(widgets.at(-1), ['subagents-status', undefined]);
  ui.dispose();
  assert.equal(listeners.size, 0);
  assert.equal(
    widgets.every(([id]) => id === 'subagents-status'),
    true,
  );
  createSubagentUI({ ctx: { ...ctx, mode: 'rpc' }, manager });
  assert.equal(listeners.size, 0);
});

test('list groups its header, choices and help with spacing and borders at narrow widths', async () => {
  const agents = [agent('A1', 'completed'), agent('A2', 'failed')];
  let component;
  const ui = createSubagentUI({
    ctx: {
      mode: 'tui',
      ui: {
        setWidget() {},
        custom: factory =>
          new Promise(resolve => {
            component = factory({ requestRender() {} }, { fg: (_name, text) => text }, {}, resolve);
          }),
      },
    },
    manager: { compactAgents: () => agents, activeAgentIds: () => [], subscribe: () => () => {} },
    getConfig: async () => ({ maxConcurrent: 4 }),
  });
  const opened = ui.open();
  for (const width of [20, 40, 80]) {
    const lines = component.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    if (width >= 40) assert.match(lines.join(' '), /A1.*completed/);
    assert.doesNotMatch(lines.join(' '), /unverified/);
    assert.ok(lines.filter(line => /^─/u.test(line)).length >= 2);
    assert.ok(lines.some(line => !line.trim()));
  }
  ui.dispose();
  await opened;
});

test('list aligns alias, status, duration and mission across varied values', async () => {
  const agents = [
    agent('A1', 'completed', 'Première mission'),
    agent('Agent🐈', 'awaiting_confirmation', 'Deuxième mission'),
    agent('A12', 'failed', 'Troisième mission'),
  ];
  agents[0].run.finishedAt = '2025-01-01T00:00:07Z';
  agents[1].run.startedAt = '2025-01-01T00:00:00Z';
  agents[2].run.finishedAt = '2025-01-01T00:03:12Z';
  let component;
  const ui = createSubagentUI({
    ctx: {
      mode: 'tui',
      ui: {
        setWidget() {},
        custom: factory =>
          new Promise(resolve => {
            component = factory({ requestRender() {} }, { fg: (_name, text) => text }, {}, resolve);
          }),
      },
    },
    manager: { compactAgents: () => agents, activeAgentIds: () => [], subscribe: () => () => {} },
    getConfig: async () => ({ maxConcurrent: 4 }),
  });
  const opened = ui.open();
  const rows = component.render(120).filter(line => /mission/u.test(line));
  assert.equal(rows.length, 3);
  const columns = rows.map(line => {
    const match = /^(.*?)((?:completed|awaiting confirmation|failed))\s+(\d+[ms]\d*s|\d+s)\s+·\s+(.*mission)/du.exec(
      line,
    );
    assert.ok(match, line);
    return [2, 3, 4].map(index => visibleWidth(line.slice(0, match.indices[index][0])));
  });
  assert.deepEqual(columns[1], columns[0]);
  assert.deepEqual(columns[2], columns[0]);
  ui.dispose();
  await opened;
});

test('list reports cumulative execution time without counting gaps', async () => {
  const archived = agent('A1', 'completed');
  archived.run.startedAt = '2026-01-01T00:00:00Z';
  archived.run.finishedAt = '2026-01-01T00:00:23Z';
  archived.runs = [
    { state: 'completed', startedAt: '2025-12-31T00:00:00Z', finishedAt: '2025-12-31T00:00:40Z' },
    archived.run,
  ];
  let component;
  const ui = createSubagentUI({
    ctx: {
      mode: 'tui',
      ui: {
        setWidget() {},
        custom: factory =>
          new Promise(resolve => {
            component = factory({ requestRender() {} }, { fg: (_name, text) => text }, {}, resolve);
          }),
      },
    },
    manager: { compactAgents: () => [archived], activeAgentIds: () => [], subscribe: () => () => {} },
    getConfig: async () => ({ maxConcurrent: 4 }),
  });
  const opened = ui.open();
  assert.match(component.render(80).join(' '), /A1.*completed.*1m03s/);
  ui.dispose();
  await opened;
});

test('detail stops only the selected agent without touching a sibling', async () => {
  const agents = [agent('A1', 'running'), agent('A2', 'running')].map(a => ({
    ...a,
    task: 'read',
    context: 'selected',
    model: { provider: 'test', id: 'm' },
    tools: ['read'],
    runs: [],
  }));
  const stopped = [];
  let component;
  const manager = {
    compactAgents: () => agents,
    activeAgentIds: () => agents.map(a => a.agentId),
    findAgent: id => agents.find(a => a.agentId === id),
    subscribe: () => () => {},
    assertCurrentBranch: () => {},
    transcript: async () => ({ text: '', nextCursor: undefined }),
    stop: async ({ agentId }) => {
      stopped.push(agentId);
      agents.find(a => a.agentId === agentId).run.state = 'cancelled';
    },
  };
  const ctx = {
    mode: 'tui',
    ui: {
      setWidget() {},
      custom: factory =>
        new Promise(resolve => {
          component = factory({ requestRender() {} }, { fg: (_name, text) => text }, { matches: () => false }, resolve);
        }),
    },
  };
  const ui = createSubagentUI({ ctx, manager, getConfig: async () => ({ maxConcurrent: 4 }) });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(component.render(80).join(' '), /Stopping/);
  component.handleInput('s');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(stopped, ['id-A1']);
  assert.equal(agents[1].run.state, 'running');
  ui.dispose();
  await opened;
});

test('detail separates mission, result and transcript without conflating completed with verified', async () => {
  const archived = {
    ...agent('A1', 'completed'),
    task: 'Read',
    context: 'Selected',
    model: { provider: 'test', id: 'm' },
    tools: ['read'],
    runs: [],
  };
  archived.run.runId = 'run-1';
  let component;
  const manager = {
    compactAgents: () => [archived],
    activeAgentIds: () => [],
    findAgent: () => archived,
    subscribe: () => () => {},
    transcript: async () => ({
      text: `${JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'TRACE' }] } })}\n`,
      nextCursor: undefined,
    }),
    result: async () => ({ text: 'EVIDENCE', nextCursor: undefined }),
  };
  const ui = createSubagentUI({
    ctx: {
      mode: 'tui',
      ui: {
        setWidget() {},
        custom: factory =>
          new Promise(resolve => {
            component = factory({ requestRender() {} }, { fg: (_name, text) => text }, {}, resolve);
          }),
      },
    },
    manager,
    getConfig: async () => ({ maxConcurrent: 4 }),
  });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  for (const width of [20, 40, 80]) {
    const lines = component.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(lines.filter(line => /^─/u.test(line)).length >= 2);
    assert.ok(lines.filter(line => !line.trim()).length >= 2);
    assert.match(lines.join(' '), /EVIDENCE/);
    assert.doesNotMatch(lines.join(' '), /TRACE/);
    if (width >= 40) assert.match(lines.join(' ').replace(/\s+/gu, ' '), /Latest run · verify/);
    assert.equal(lines.length, 40, 'the overlay covers the whole terminal');
    component.handleInput('a');
    assert.match(component.render(width).join(' '), /TRACE/);
    assert.doesNotMatch(component.render(width).join(' '), /EVIDENCE/);
    component.handleInput('r');
  }
  ui.dispose();
  await opened;
});

test('narrow detail keeps header, result and navigation visible with realistic metadata', async () => {
  const archived = {
    ...agent('A2', 'completed', 'Lecture rapide des scripts'),
    task: 'Lis uniquement package.json et résume en une phrase les scripts disponibles. Ne modifie aucun fichier.',
    context: 'Test rapide de trois sous-agents en lecture seule dans un dépôt local.',
    model: { provider: 'openai-codex', id: 'gpt-6-sol' },
    thinkingLevel: 'medium',
    tools: [
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
      'code_nav',
      'web_search',
      'web_fetch',
      'context7_resolve',
      'context7_docs',
      'browser_open',
    ],
    runs: [
      {
        activities: [
          { activity: 'assistant message' },
          { activity: 'tool: read' },
          { activity: 'tool finished: read' },
        ],
      },
    ],
  };
  archived.run.runId = 'run-1';
  let component;
  const manager = {
    compactAgents: () => [archived],
    activeAgentIds: () => [],
    findAgent: () => archived,
    subscribe: () => () => {},
    transcript: async () => ({
      text:
        Array.from({ length: 40 }, (_, index) =>
          JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: `line-${index}` }] } }),
        ).join('\n') + '\n',
      nextCursor: undefined,
    }),
    result: async () => ({ text: 'Script test', nextCursor: undefined }),
  };
  const ui = createSubagentUI({
    ctx: {
      mode: 'tui',
      ui: {
        setWidget() {},
        custom: factory =>
          new Promise(resolve => {
            component = factory({ requestRender() {} }, { fg: (_name, text) => text }, {}, resolve);
          }),
      },
    },
    manager,
    getConfig: async () => ({ maxConcurrent: 4 }),
  });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  const narrow = component.render(40);
  assert.equal(narrow.length, 40);
  assert.match(narrow.join(' '), /Script test/);
  assert.match(narrow.join(' '), /A2/);
  const wide = component.render(120).join(' ');
  assert.match(wide, /Response/);
  assert.doesNotMatch(wide, /Agent · line-/);
  assert.doesNotMatch(wide, /Suivi|Résultat et messages|assistant message|dernier run/);
  assert.match(wide, /Latest run/i);
  ui.dispose();
  await opened;
});

test('detail fits a 40×24 TUI while keeping metadata accessible separately', async () => {
  const archived = {
    ...agent('A1', 'completed', 'Long title about delegated investigations'),
    task: 'Read the repository and summarize all documentation without changing files '.repeat(3),
    context: 'Selected background context '.repeat(5),
    model: { provider: 'openai-codex', id: 'fixture' },
    thinkingLevel: 'medium',
    tools: Array.from({ length: 20 }, (_, i) => `tool_${i}`),
    runs: [],
  };
  archived.run.runId = 'run-1';
  let component;
  const manager = {
    compactAgents: () => [archived],
    activeAgentIds: () => [],
    findAgent: () => archived,
    subscribe: () => () => {},
    transcript: async () => ({
      text:
        Array.from({ length: 40 }, (_, index) =>
          JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: `line-${index}` }] } }),
        ).join('\n') + '\n',
      nextCursor: undefined,
    }),
    result: async () => ({ text: 'REAL_RESULT', nextCursor: undefined }),
  };
  const ui = createSubagentUI({
    ctx: {
      mode: 'tui',
      ui: {
        setWidget() {},
        custom: factory =>
          new Promise(resolve => {
            component = factory(
              { terminal: { rows: 24 }, requestRender() {} },
              { fg: (_name, text) => text },
              {},
              resolve,
            );
          }),
      },
    },
    manager,
    getConfig: async () => ({ maxConcurrent: 4 }),
  });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  const reading = component.render(40);
  assert.equal(reading.length, 24, 'fullscreen overlay covers Pi instead of reserving space for it');
  assert.match(reading.join(' '), /REAL_RESULT/);
  assert.doesNotMatch(reading.join(' '), /s stop/);
  component.handleInput('i');
  const info = component.render(40);
  assert.equal(info.length, 24);
  assert.match(info.join(' '), /Initial mission/);
  component.handleInput('r');
  assert.match(component.render(40).join(' '), /REAL_RESULT/);
  ui.dispose();
  await opened;
});

test('detail preserves a scrolled reading position when new transcript events arrive', async () => {
  const active = {
    ...agent('A1', 'running'),
    task: 'read',
    context: '',
    model: { provider: 'test', id: 'm' },
    tools: [],
    runs: [],
  };
  let transcript =
    Array.from({ length: 30 }, (_, index) =>
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: `line-${index}` }] } }),
    ).join('\n') + '\n';
  const listeners = new Set();
  let component;
  const manager = {
    compactAgents: () => [active],
    activeAgentIds: () => ['id-A1'],
    findAgent: () => active,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    transcript: async ({ cursor }) => ({ text: transcript.slice(cursor), nextCursor: undefined }),
  };
  const ctx = {
    mode: 'tui',
    ui: {
      setWidget() {},
      custom: factory =>
        new Promise(resolve => {
          component = factory({ requestRender() {} }, { fg: (_name, text) => text }, { matches: () => false }, resolve);
        }),
    },
  };
  const ui = createSubagentUI({ ctx, manager, getConfig: async () => ({ maxConcurrent: 4 }) });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  component.handleInput('\x1b[H');
  component.render(80);
  component.handleInput('\x1b[B');
  const before = component.render(80).join(' ');
  assert.match(before, /line-1/);
  transcript += `${JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'line-30' }] } })}\n`;
  for (const listener of listeners) listener({ agentId: active.agentId });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(component.render(80).join(' '), /line-1/);
  ui.dispose();
  await opened;
});

test('detail catches a final transcript update that happens during its initial read', async () => {
  const active = {
    ...agent('A1', 'running'),
    task: 'read',
    context: '',
    model: { provider: 'test', id: 'm' },
    tools: [],
    runs: [],
  };
  const first = `${JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'FIRST' }] } })}\n`;
  const last = `${JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'LAST_UPDATE' }] } })}\n`;
  let transcript = first;
  let release;
  let reads = 0;
  const listeners = new Set();
  let component;
  const manager = {
    compactAgents: () => [active],
    activeAgentIds: () => [active.agentId],
    findAgent: () => active,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    transcript: async ({ cursor = 0 }) => {
      reads += 1;
      if (reads === 1)
        return new Promise(resolve => {
          release = () => resolve({ text: first, nextCursor: undefined });
        });
      return { text: transcript.slice(cursor), nextCursor: undefined };
    },
  };
  const ui = createSubagentUI({
    ctx: {
      mode: 'tui',
      ui: {
        setWidget() {},
        custom: factory =>
          new Promise(resolve => {
            component = factory({ requestRender() {} }, { fg: (_name, text) => text }, {}, resolve);
          }),
      },
    },
    manager,
    getConfig: async () => ({ maxConcurrent: 4 }),
  });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  transcript += last;
  for (const listener of listeners) listener({ agentId: active.agentId, state: 'completed' });
  release();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  component.render(80);
  for (let i = 0; i < 20; i++) component.handleInput('\x1b[B');
  assert.ok(reads > 1, 'mount must refresh after the initial read to close the subscription gap');
  assert.match(component.render(80).join(' '), /LAST_UPDATE/);
  ui.dispose();
  await opened;
});

test('an open transcript receives new events while the reader stays above the end', async () => {
  const active = {
    ...agent('A1', 'running'),
    task: 'read',
    context: '',
    model: { provider: 'test', id: 'm' },
    tools: [],
    runs: [],
  };
  let transcript =
    Array.from({ length: 40 }, (_, index) =>
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: `line-${index}` }] } }),
    ).join('\n') + '\n';
  const listeners = new Set();
  let component;
  let reads = 0;
  const manager = {
    compactAgents: () => [active],
    activeAgentIds: () => [active.agentId],
    findAgent: () => active,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    transcript: async ({ cursor = 0 }) => {
      reads += 1;
      return { text: transcript.slice(cursor), nextCursor: undefined };
    },
  };
  const ui = createSubagentUI({
    ctx: {
      mode: 'tui',
      ui: {
        setWidget() {},
        custom: factory =>
          new Promise(resolve => {
            component = factory({ requestRender() {} }, { fg: (_name, text) => text }, {}, resolve);
          }),
      },
    },
    manager,
    getConfig: async () => ({ maxConcurrent: 4 }),
  });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  component.handleInput('\x1b[H');
  component.render(80);
  for (let i = 0; i < 4; i++) component.handleInput('\x1b[B');
  const reading = transcriptRow(component.render(80));
  assert.ok(reading);
  transcript += `${JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'FRESH_EVENT' }] } })}\n`;
  for (const listener of listeners) listener({ agentId: active.agentId, state: 'running' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(reads > 1, 'an update must read the new bytes even when not following the tail');
  assert.equal(transcriptRow(component.render(80)), reading);
  for (let i = 0; i < 80; i++) component.handleInput('\x1b[B');
  assert.match(component.render(80).join(' '), /FRESH_EVENT/);
  ui.dispose();
  await opened;
});

test('manual scrolling while a transcript refresh is pending cancels auto-follow', async () => {
  const active = {
    ...agent('A1', 'running'),
    task: 'read',
    context: '',
    model: { provider: 'test', id: 'm' },
    tools: [],
    runs: [],
  };
  let transcript =
    Array.from({ length: 40 }, (_, index) =>
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: `line-${index}` }] } }),
    ).join('\n') + '\n';
  let release;
  let reads = 0;
  const listeners = new Set();
  let component;
  const manager = {
    compactAgents: () => [active],
    activeAgentIds: () => [active.agentId],
    findAgent: () => active,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    transcript: async ({ cursor = 0 }) => {
      reads += 1;
      if (reads === 2)
        return new Promise(resolve => {
          release = () => resolve({ text: transcript.slice(cursor), nextCursor: undefined });
        });
      return { text: transcript.slice(cursor), nextCursor: undefined };
    },
  };
  const ui = createSubagentUI({
    ctx: {
      mode: 'tui',
      ui: {
        setWidget() {},
        custom: factory =>
          new Promise(resolve => {
            component = factory({ requestRender() {} }, { fg: (_name, text) => text }, {}, resolve);
          }),
      },
    },
    manager,
    getConfig: async () => ({ maxConcurrent: 4 }),
  });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  component.render(80);
  for (let i = 0; i < 80; i++) component.handleInput('\x1b[B');
  transcript += `${JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'NEW_TAIL' }] } })}\n`;
  for (const listener of listeners) listener({ agentId: active.agentId, state: 'running' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  for (let i = 0; i < 4; i++) component.handleInput('\x1b[A');
  const reading = transcriptRow(component.render(80));
  assert.ok(reading);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transcriptRow(component.render(80)), reading);
  ui.dispose();
  await opened;
});

test('a result arriving while reading earlier transcript lines loads without moving the reader', async () => {
  const active = {
    ...agent('A1', 'running'),
    task: 'read',
    context: '',
    model: { provider: 'test', id: 'm' },
    tools: [],
    runs: [],
  };
  active.run.runId = 'run-1';
  const transcript =
    Array.from({ length: 40 }, (_, index) =>
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: `line-${index}` }] } }),
    ).join('\n') + '\n';
  const listeners = new Set();
  let component;
  let reads = 0;
  const manager = {
    compactAgents: () => [active],
    activeAgentIds: () => (active.run.state === 'running' ? ['id-A1'] : []),
    findAgent: () => active,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    transcript: async ({ cursor = 0 }) => ({ text: transcript.slice(cursor), nextCursor: undefined }),
    result: async () => {
      reads++;
      return { text: 'ARRIVED_EVIDENCE', nextCursor: undefined };
    },
  };
  const ctx = {
    mode: 'tui',
    ui: {
      setWidget() {},
      custom: factory =>
        new Promise(resolve => {
          component = factory({ requestRender() {} }, { fg: (_name, text) => text }, { matches: () => false }, resolve);
        }),
    },
  };
  const ui = createSubagentUI({ ctx, manager, getConfig: async () => ({ maxConcurrent: 4 }) });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  component.handleInput('\x1b[H');
  component.render(80);
  for (let i = 0; i < 10; i++) component.handleInput('\x1b[B');
  const reading = transcriptRow(component.render(80));
  assert.match(reading, /line-4|line-5/);
  active.run.state = 'completed';
  for (const listener of listeners) listener({ agentId: active.agentId, state: 'completed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(transcriptRow(component.render(80)), reading);
  for (let i = 0; i < 45; i++) component.handleInput('\x1b[B');
  for (let i = 0; i < 45; i++) component.handleInput('\x1b[A');
  assert.doesNotMatch(component.render(80).join(' '), /ARRIVED_EVIDENCE/);
  component.handleInput('r');
  assert.match(component.render(80).join(' '), /ARRIVED_EVIDENCE/);
  ui.dispose();
  await opened;
});

test('an open detail replaces the previous run result when a continuation starts', async () => {
  const active = {
    ...agent('A1', 'completed'),
    task: 'read',
    context: '',
    model: { provider: 'test', id: 'm' },
    tools: [],
    runs: [],
  };
  active.run.runId = 'run-1';
  const listeners = new Set();
  let component;
  const manager = {
    compactAgents: () => [active],
    activeAgentIds: () => [],
    findAgent: () => active,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    transcript: async () => ({ text: '', nextCursor: undefined }),
    result: async ({ runId }) => ({
      text: runId === 'run-1' ? 'FIRST_RESULT' : 'SECOND_RESULT',
      nextCursor: undefined,
    }),
  };
  const ctx = {
    mode: 'tui',
    ui: {
      setWidget() {},
      custom: factory =>
        new Promise(resolve => {
          component = factory({ requestRender() {} }, { fg: (_name, text) => text }, { matches: () => false }, resolve);
        }),
    },
  };
  const ui = createSubagentUI({ ctx, manager, getConfig: async () => ({ maxConcurrent: 4 }) });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(component.render(80).join(' '), /FIRST_RESULT/);
  active.run = { runId: 'run-2', state: 'running' };
  for (const listener of listeners) listener({ agentId: active.agentId, state: 'running' });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(component.render(80).join(' '), /FIRST_RESULT/);
  active.run.state = 'completed';
  for (const listener of listeners) listener({ agentId: active.agentId, state: 'completed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(component.render(80).join(' '), /SECOND_RESULT/);
  assert.doesNotMatch(component.render(80).join(' '), /FIRST_RESULT/);
  ui.dispose();
  await opened;
});

test('a continuation replaces its response without shifting the total activity being read', async () => {
  const active = {
    ...agent('A1', 'completed'),
    task: 'read',
    context: '',
    model: { provider: 'test', id: 'm' },
    tools: [],
    runs: [],
  };
  active.run.runId = 'run-1';
  const listeners = new Set();
  let component;
  // Keep the reader above the end even with the larger fullscreen viewport.
  const transcript =
    Array.from({ length: 80 }, (_, index) =>
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: `line-${index}` }] } }),
    ).join('\n') + '\n';
  const manager = {
    compactAgents: () => [active],
    activeAgentIds: () => [],
    findAgent: () => active,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    transcript: async ({ cursor = 0 }) => ({ text: transcript.slice(cursor), nextCursor: undefined }),
    result: async () => ({ text: Array.from({ length: 12 }, (_, i) => `old-${i}`).join('\n'), nextCursor: undefined }),
  };
  const ui = createSubagentUI({
    ctx: {
      mode: 'tui',
      ui: {
        setWidget() {},
        custom: factory =>
          new Promise(resolve => {
            component = factory({ requestRender() {} }, { fg: (_name, text) => text }, {}, resolve);
          }),
      },
    },
    manager,
    getConfig: async () => ({ maxConcurrent: 4 }),
  });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  component.handleInput('a');
  component.render(80);
  for (let i = 0; i < 18; i++) component.handleInput('\x1b[B');
  const first = transcriptRow(component.render(80));
  assert.ok(first, 'the reader must be inside the transcript');
  active.run = { runId: 'run-2', state: 'running' };
  for (const listener of listeners) listener({ agentId: active.agentId, state: 'running' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transcriptRow(component.render(80)), first);
  ui.dispose();
  await opened;
});

test('late result from a previous run never appears under a continuation', async () => {
  const active = {
    ...agent('A1', 'running'),
    task: 'read',
    context: '',
    model: { provider: 'test', id: 'm' },
    tools: [],
    runs: [],
  };
  active.run.runId = 'run-1';
  const listeners = new Set();
  let component;
  let releaseOld;
  const manager = {
    compactAgents: () => [active],
    activeAgentIds: () => [],
    findAgent: () => active,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    transcript: async () => ({ text: '', nextCursor: undefined }),
    result: async ({ runId }) =>
      runId === 'run-1'
        ? new Promise(resolve => {
            releaseOld = () => resolve({ text: 'STALE_RESULT', nextCursor: undefined });
          })
        : { text: 'CURRENT_RESULT', nextCursor: undefined },
  };
  const ui = createSubagentUI({
    ctx: {
      mode: 'tui',
      ui: {
        setWidget() {},
        custom: factory =>
          new Promise(resolve => {
            component = factory({ requestRender() {} }, { fg: (_name, text) => text }, {}, resolve);
          }),
      },
    },
    manager,
    getConfig: async () => ({ maxConcurrent: 4 }),
  });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  active.run.state = 'completed';
  for (const listener of listeners) listener({ agentId: active.agentId, state: 'completed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releaseOld, 'function');
  active.run = { runId: 'run-2', state: 'running' };
  for (const listener of listeners) listener({ agentId: active.agentId, state: 'running' });
  releaseOld();
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(component.render(80).join(' '), /STALE_RESULT/);
  active.run.state = 'completed';
  for (const listener of listeners) listener({ agentId: active.agentId, state: 'completed' });
  await new Promise(resolve => setImmediate(resolve));
  component.handleInput('r');
  const displayed = component.render(80).join(' ');
  assert.match(displayed, /CURRENT_RESULT/);
  assert.doesNotMatch(displayed, /STALE_RESULT/);
  ui.dispose();
  await opened;
});

test('late failure from a previous run is not shown under a continuation', async () => {
  const active = {
    ...agent('A1', 'running'),
    task: 'read',
    context: '',
    model: { provider: 'test', id: 'm' },
    tools: [],
    runs: [],
  };
  active.run.runId = 'run-1';
  const listeners = new Set();
  let component;
  let failOld;
  const manager = {
    compactAgents: () => [active],
    activeAgentIds: () => [],
    findAgent: () => active,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    transcript: async () => ({ text: '', nextCursor: undefined }),
    result: async ({ runId }) =>
      runId === 'run-1'
        ? new Promise((_, reject) => {
            failOld = () => reject(new Error('STALE_ERROR'));
          })
        : { text: 'CURRENT_RESULT', nextCursor: undefined },
  };
  const ui = createSubagentUI({
    ctx: {
      mode: 'tui',
      ui: {
        setWidget() {},
        custom: factory =>
          new Promise(resolve => {
            component = factory({ requestRender() {} }, { fg: (_name, text) => text }, {}, resolve);
          }),
      },
    },
    manager,
    getConfig: async () => ({ maxConcurrent: 4 }),
  });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  active.run.state = 'completed';
  for (const listener of listeners) listener({ agentId: active.agentId, state: 'completed' });
  await new Promise(resolve => setImmediate(resolve));
  active.run = { runId: 'run-2', state: 'running' };
  for (const listener of listeners) listener({ agentId: active.agentId, state: 'running' });
  failOld();
  await new Promise(resolve => setImmediate(resolve));
  active.run.state = 'completed';
  for (const listener of listeners) listener({ agentId: active.agentId, state: 'completed' });
  await new Promise(resolve => setImmediate(resolve));
  component.handleInput('r');
  const displayed = component.render(80).join(' ');
  assert.match(displayed, /CURRENT_RESULT/);
  assert.doesNotMatch(displayed, /STALE_ERROR/);
  ui.dispose();
  await opened;
});

test('response pagination preserves the separate activity reading position', async () => {
  const active = {
    ...agent('A1', 'completed'),
    task: 'read',
    context: '',
    model: { provider: 'test', id: 'm' },
    tools: [],
    runs: [],
  };
  active.run.runId = 'run-1';
  const transcript =
    Array.from({ length: 40 }, (_, index) =>
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: `line-${index}` }] } }),
    ).join('\n') + '\n';
  let component;
  const manager = {
    compactAgents: () => [active],
    activeAgentIds: () => [],
    findAgent: () => active,
    subscribe: () => () => {},
    transcript: async () => ({ text: transcript, nextCursor: undefined }),
    result: async ({ cursor }) =>
      cursor === undefined
        ? { text: 'FIRST_PAGE', nextCursor: 1 }
        : {
            text: '\n' + Array.from({ length: 8 }, (_, index) => `SECOND_PAGE_${index}`).join('\n'),
            nextCursor: undefined,
          },
  };
  const ctx = {
    mode: 'tui',
    ui: {
      setWidget() {},
      custom: factory =>
        new Promise(resolve => {
          component = factory({ requestRender() {} }, { fg: (_name, text) => text }, { matches: () => false }, resolve);
        }),
    },
  };
  const ui = createSubagentUI({ ctx, manager, getConfig: async () => ({ maxConcurrent: 4 }) });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  component.handleInput('a');
  component.render(80);
  for (let i = 0; i < 7; i++) component.handleInput('\x1b[B');
  const firstTranscriptRow = () => transcriptRow(component.render(80));
  const before = firstTranscriptRow();
  assert.ok(before);
  component.handleInput('r');
  component.render(80);
  component.handleInput('\x1b[B');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(component.render(80).join(' '), /SECOND_PAGE/);
  component.handleInput('a');
  assert.equal(firstTranscriptRow(), before);
  ui.dispose();
  await opened;
});

test('transcript pagination bounds the open view and older pages can be reopened', async () => {
  const active = {
    ...agent('A1', 'running'),
    task: 'read',
    context: '',
    model: { provider: 'test', id: 'm' },
    tools: [],
    runs: [],
  };
  const pages = Array.from(
    { length: 4 },
    (_, page) =>
      Array.from({ length: 200 }, (_, index) =>
        JSON.stringify({
          message: { role: 'assistant', content: [{ type: 'text', text: `page-${page}-line-${index}` }] },
        }),
      ).join('\n') + '\n',
  );
  let component;
  const manager = {
    compactAgents: () => [active],
    activeAgentIds: () => ['id-A1'],
    findAgent: () => active,
    subscribe: () => () => {},
    transcript: async ({ cursor = 0 }) => ({
      text: pages[cursor] ?? '',
      nextCursor: cursor < 3 ? cursor + 1 : undefined,
    }),
  };
  const ctx = {
    mode: 'tui',
    ui: {
      setWidget() {},
      custom: factory =>
        new Promise(resolve => {
          component = factory({ requestRender() {} }, { fg: (_name, text) => text }, { matches: () => false }, resolve);
        }),
    },
  };
  const ui = createSubagentUI({ ctx, manager, getConfig: async () => ({ maxConcurrent: 4 }) });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  component.handleInput('\x1b[H');
  component.render(80);
  for (let page = 1; page < 4; page += 1) {
    for (let line = 0; line < 400; line++) component.handleInput('\x1b[B');
    await new Promise(resolve => setImmediate(resolve));
    component.render(80);
  }
  const bounded = component.render(80).join(' ');
  assert.match(bounded, /Earlier content/);
  assert.doesNotMatch(bounded, /page-0-line-0/);
  component.handleInput('\x1b');
  await new Promise(resolve => setImmediate(resolve));
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  component.handleInput('\x1b[H');
  assert.match(component.render(80).join(' '), /page-0-line-0/);
  ui.dispose();
  await opened;
});

test('settings reports failed persistence without announcing success', async () => {
  initTheme('dark');
  let component;
  const notes = [];
  const ctx = {
    mode: 'tui',
    ui: {
      setWidget() {},
      notify: message => notes.push(message),
      custom: factory =>
        new Promise(resolve => {
          component = factory({ requestRender() {} }, { fg: (_name, text) => text }, {}, resolve);
        }),
    },
  };
  const manager = { compactAgents: () => [], activeAgentIds: () => [], subscribe: () => () => {} };
  const ui = createSubagentUI({
    ctx,
    manager,
    getConfig: async () => ({ autoDelegate: true, maxConcurrent: 4 }),
    updateConfig: async () => {
      throw new Error('read-only');
    },
  });
  const pending = ui.settings();
  await new Promise(resolve => setImmediate(resolve));
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(notes.some(note => /Save failed.*read-only/.test(note)));
  assert.ok(notes.every(note => !note.includes('saved')));
  ui.dispose();
  await pending;
});

test('transcript parsing retains large tool output for the native renderer', () => {
  const [message] = transcriptMessages(
    `${JSON.stringify({
      message: { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(2000) }] },
    })}\n`,
  );
  assert.equal(message.content[0].text.length, 2000);
});

test('native transcript exposes tool calls without leaking thinking or image data', () => {
  const text = JSON.stringify({
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'SECRET' },
        { type: 'toolCall', name: 'read', arguments: { path: 'a.txt' } },
        { type: 'image', data: 'SECRET_IMAGE' },
        { type: 'text', text: 'hello' },
      ],
    },
  });
  const transcript = new ActivityTranscript();
  transcript.appendArchive(transcriptMessages(`${text}\n`));
  const output = transcript.render(80).join('\n');
  assert.match(output, /read/);
  assert.match(output, /hello/);
  assert.doesNotMatch(output, /SECRET/);
});

test('detail reads the archived result from manager instead of only labeling it available', async () => {
  const archived = {
    ...agent('A1', 'completed'),
    task: 'task',
    context: '',
    model: { provider: 'test', id: 'm' },
    tools: [],
    runs: [],
  };
  archived.run.runId = 'run-1';
  let component;
  const manager = {
    compactAgents: () => [archived],
    activeAgentIds: () => [],
    findAgent: () => archived,
    subscribe: () => () => {},
    transcript: async () => ({ text: '', nextCursor: undefined }),
    result: async () => ({ text: 'INDEPENDENT_EVIDENCE', nextCursor: undefined }),
  };
  const ctx = {
    mode: 'tui',
    ui: {
      setWidget() {},
      custom: factory =>
        new Promise(resolve => {
          component = factory({ requestRender() {} }, { fg: (_name, text) => text }, { matches: () => false }, resolve);
        }),
    },
  };
  const ui = createSubagentUI({ ctx, manager, getConfig: async () => ({ maxConcurrent: 4 }) });
  const opened = ui.open();
  component.handleInput('\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(component.render(120).join(' '), /INDEPENDENT_EVIDENCE/);
  const narrow = component.render(40);
  assert.ok(narrow.every(line => visibleWidth(line) <= 40));
  component.handleInput('i');
  let info = component.render(40).join(' ');
  for (let i = 0; i < 12; i++) {
    component.handleInput('\x1b[B');
    info += component.render(40).join(' ');
  }
  assert.match(info, /reasoning:/);
  assert.match(info, /unavailable/);
  ui.dispose();
  await opened;
});

test('legacy subagent event states render in English', () => {
  const fake = createFakePi();
  registerSubagentRenderers(fake.pi);
  const entry = fake.entryRenderers.get('subagents-event-v1')(
    { data: { alias: 'A1', state: 'confirmation demandée', title: 'Archive' } },
    {},
    { fg: (_color, text) => text },
  );
  assert.match(entry.render(80).join(' '), /confirmation requested/);
});

test('result and event cards point to the supported subagent interface', () => {
  const fake = createFakePi();
  registerSubagentRenderers(fake.pi);
  const renderEntry = fake.entryRenderers.get('subagents-event-v1');
  const renderResult = fake.messageRenderers.get('subagents-result-v1');
  const theme = { fg: (_name, text) => text };
  for (const expanded of [false, true]) {
    const result = renderResult(
      { details: { agentId: 'id-1', alias: 'A1', runId: 'run-1', state: 'completed' }, content: 'EVIDENCE' },
      { expanded },
      theme,
    ).render(100);
    assert.equal(result.at(-1), '/subagents');
    assert.doesNotMatch(result.join('\n'), /subagents show/);
    const event = renderEntry(
      { data: { agentId: 'id-1', alias: 'A1', state: 'cancelled', title: 'Mission' } },
      { expanded },
      theme,
    )
      .render(100)
      .join('\n');
    assert.doesNotMatch(event, /subagents show/);
    if (expanded) {
      assert.match(event, /\n\/subagents\n/);
      assert.match(event, /Changes already made remain in place/);
    }
  }
});

test('result card remains compact, neutralizes untrusted output and never claims verification', () => {
  const fake = createFakePi();
  registerSubagentRenderers(fake.pi);
  const theme = { fg: (_color, text) => text };
  const render = fake.messageRenderers.get('subagents-result-v1');
  const component = render(
    { content: 'A1 \x1b]0;bad\x07 completed', details: { agentId: 'id-1', runId: 'run-1', state: 'completed' } },
    { expanded: false, outputPad: 0 },
    theme,
  );
  const lines = component.render(40);
  assert.ok(lines.every(line => visibleWidth(line) <= 40));
  assert.doesNotMatch(lines.join(' '), /\x1b\]0;bad|\x1b\[31m/);
  assert.match(lines.join(' '), /unverified/);
  const timed = render(
    {
      content: 'Result available.',
      details: {
        agentId: 'agent-long-id',
        alias: 'A2',
        runId: 'run-2',
        state: 'completed',
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:00:23Z',
        preview: 'EVIDENCE',
      },
    },
    { expanded: false, outputPad: 0 },
    theme,
  )
    .render(80)
    .join(' ');
  assert.match(timed, /A2.*23s.*run-2/);
  const withPreview = render(
    {
      content: 'Result available. Retrieve with subagent_result.',
      details: {
        agentId: 'id-1',
        runId: 'run-1',
        state: 'completed',
        preview: 'UNTRUSTED_CHILD_EVIDENCE\x1b]0;bad\x07',
      },
    },
    { expanded: false, outputPad: 0 },
    theme,
  )
    .render(80)
    .join(' ');
  assert.match(withPreview, /UNTRUSTED_CHILD_EVIDENCE/);
  assert.doesNotMatch(withPreview, /Retrieve with|\x1b\]0;bad/);
});

test('a completion card is hidden after its exact run is read, while failures remain visible', () => {
  const fake = createFakePi();
  const read = new Set();
  registerSubagentRenderers(fake.pi, { wasRead: details => read.has(`${details.agentId}:${details.runId}`) });
  const theme = { fg: (_name, text) => text };
  const render = fake.messageRenderers.get('subagents-result-v1');
  const completed = {
    details: { agentId: 'agent-1', runId: 'run-1', state: 'completed', preview: 'EVIDENCE' },
    content: 'available',
  };
  const card = render(completed, { expanded: false }, theme);
  assert.match(card.render(80).join(' '), /EVIDENCE/);
  read.add('agent-1:run-1');
  assert.deepEqual(card.render(80), [], 'an already-mounted card must disappear when the result is read');
  assert.match(
    render({ ...completed, details: { ...completed.details, runId: 'run-2' } }, { expanded: false }, theme)
      .render(80)
      .join(' '),
    /EVIDENCE/,
  );
  assert.match(
    render({ ...completed, details: { ...completed.details, state: 'failed' } }, { expanded: false }, theme)
      .render(80)
      .join(' '),
    /failed/,
  );
});

test('entry point routes bare command to TUI, keeps text in RPC and cleans widget on shutdown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagents-ui-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const widgets = [];
  const notes = [];
  const fake = createFakePi();
  subagents(fake.pi, {
    agentDir: root,
    configPath: join(root, 'settings.json'),
    createRuntime: async () => {
      throw new Error('must not launch');
    },
  });
  const ctx = {
    mode: 'tui',
    hasUI: true,
    cwd: root,
    sessionManager: SessionManager.inMemory(root),
    ui: { setWidget: (...args) => widgets.push(args), notify: text => notes.push(text), custom: async () => null },
  };
  await fake.fire('session_start', {}, ctx);
  await fake.commands.get('subagents').handler('', ctx);
  assert.match(notes.at(-1), /No subagents/);
  const before = notes.length;
  await fake.commands.get('subagents').handler('', { ...ctx, mode: 'rpc' });
  assert.equal(notes.length, before + 1);
  assert.match(notes.at(-1), /No subagents/);
  await fake.fire('session_shutdown', {}, ctx);
  assert.deepEqual(widgets.at(-1), ['subagents-status', undefined]);
});

test('settings UI persists every user-configurable setting and keeps the archive-only widget hidden', async t => {
  initTheme('dark');
  const waitFor = async check => {
    const deadline = Date.now() + 2000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), 'the settings view must finish loading');
  };
  let component;
  const root = await mkdtemp(join(tmpdir(), 'subagents-settings-widget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = SessionManager.inMemory(root);
  const store = new SubagentStore({ agentDir: root, ownerSessionId: session.getSessionId() });
  await store.saveAgent({
    agentId: '123e4567-e89b-42d3-a456-426614174000',
    ownerSessionId: session.getSessionId(),
    branchId: 'root',
    alias: 'A1',
    title: 'Archive',
    task: 'Read',
    context: '',
    runs: [{ runId: 'run-1', state: 'completed' }],
  });
  const widgets = new Map();
  const fake = createFakePi();
  const configPath = join(root, 'config.json');
  subagents(fake.pi, {
    agentDir: root,
    configPath,
    createRuntime: async () => {
      throw new Error('must not launch');
    },
  });
  const ctx = {
    mode: 'tui',
    hasUI: true,
    cwd: root,
    sessionManager: session,
    ui: {
      notify() {},
      setWidget: (id, widget) => (widget ? widgets.set(id, widget) : widgets.delete(id)),
      custom: factory =>
        new Promise(resolve => {
          component = factory(
            { terminal: { rows: 24 }, requestRender() {} },
            { fg: (_name, text) => text },
            {},
            resolve,
          );
        }),
    },
  };
  await fake.fire('session_start', {}, ctx);
  assert.equal(widgets.has('subagents-status'), false);
  const settings = fake.commands.get('subagents').handler('settings', ctx);
  await waitFor(() =>
    component
      ?.render(100)
      .join('\n')
      .match(/Automatic delegation.*on/),
  );
  const initialSettings = component;
  component.handleInput('\r');
  await waitFor(
    () =>
      component !== initialSettings &&
      component
        .render(100)
        .join('\n')
        .match(/Automatic delegation.*off/),
  );
  assert.deepEqual(await loadSubagentConfig({ path: configPath }), { ...DEFAULT_SUBAGENT_CONFIG, autoDelegate: false });
  component.handleInput('\x1b[B');
  component.handleInput('\r');
  await waitFor(() =>
    component
      .render(100)
      .join('\n')
      .match(/Global limit/),
  );
  component.handleInput('\x1b[F');
  component.handleInput('\x15');
  component.handleInput('2');
  component.handleInput('\r');
  await waitFor(() =>
    component
      .render(100)
      .join('\n')
      .match(/Maximum concurrency.*2/),
  );
  const saved = await loadSubagentConfig({ path: configPath });
  assert.deepEqual(saved, { ...DEFAULT_SUBAGENT_CONFIG, autoDelegate: false, maxConcurrent: 2 });
  assert.deepEqual(
    Object.keys(saved)
      .filter(key => key !== 'version')
      .sort(),
    ['autoDelegate', 'maxConcurrent'],
    'all configurable fields were exercised through the UI',
  );
  assert.match(component.render(100).join('\n'), /Maximum concurrency.*2/);
  component.handleInput('\x1b');
  await settings;
  assert.equal(widgets.has('subagents-status'), false);
  await fake.fire('session_shutdown', {}, ctx);
});

test('a business-rejected concurrency limit stays in the editor with its value and error', async t => {
  initTheme('dark');
  const root = await mkdtemp(join(tmpdir(), 'subagents-limit-rejection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notes = [];
  let component;
  const fake = createFakePi({ getAllTools: () => [], getActiveTools: () => [] });
  const configPath = join(root, 'config.json');
  subagents(fake.pi, {
    agentDir: root,
    configPath,
    createRuntime: async () => ({
      prompt: async () => ({ runId: 'worker', result: new Promise(() => {}) }),
      stop: async () => {},
    }),
  });
  const ctx = {
    mode: 'tui',
    hasUI: true,
    cwd: root,
    isIdle: () => false,
    isProjectTrusted: () => false,
    model: {
      provider: 'openai',
      id: 'fixture',
      api: 'openai-completions',
      baseUrl: 'https://example.test/v1',
      input: ['text'],
    },
    thinkingLevel: 'off',
    modelRegistry: {},
    sessionManager: SessionManager.inMemory(root),
    ui: {
      setWidget() {},
      notify: text => notes.push(text),
      confirm: async () => true,
      custom: factory =>
        new Promise(resolve => {
          component = factory(
            { terminal: { rows: 24 }, requestRender() {} },
            { fg: (_name, text) => text },
            {},
            resolve,
          );
        }),
    },
  };
  await fake.fire('session_start', {}, ctx);
  t.after(() => fake.fire('session_shutdown', {}, ctx));
  for (let i = 0; i < 3; i++)
    await fake.tools
      .get('subagent_start')
      .execute(`start-${i}`, { title: `Active ${i}`, task: 'work', context: '' }, undefined, undefined, ctx);
  const waitFor = async check => {
    const deadline = Date.now() + 2000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), 'the expected settings state must appear');
  };
  const settings = fake.commands.get('subagents').handler('settings', ctx);
  await waitFor(() => component);
  component.handleInput('\x1b[B');
  component.handleInput('\r');
  await waitFor(() => /Global limit/.test(component.render(80).join('\n')));
  const editor = component;
  component.handleInput('\x1b[F');
  component.handleInput('\x15');
  component.handleInput('2');
  component.handleInput('\r');
  await waitFor(
    () => /Cannot lower/.test(component.render(80).join('\n')) || notes.some(note => /Cannot lower/.test(note)),
  );
  assert.equal(component, editor, 'business validation must not close the editor');
  assert.match(component.render(80).join('\n'), /Cannot lower the maximum below 3 active run\(s\)/);
  assert.match(component.render(80)[3], /2/, 'the rejected input remains visible');
  assert.equal((await loadSubagentConfig({ path: configPath })).maxConcurrent, 4);
  assert.ok(notes.every(note => !/Save failed|saved/.test(note)));
  component.handleInput('\x15');
  component.handleInput('5');
  component.handleInput('\r');
  await waitFor(() => /Maximum concurrency.*5/.test(component.render(80).join('\n')));
  assert.equal((await loadSubagentConfig({ path: configPath })).maxConcurrent, 5);
  component.handleInput('\x1b');
  await settings;
});

test('removed subcommands are rejected in every mode without editing settings or opening a view', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagents-command-surface-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notes = [];
  const fake = createFakePi();
  const configPath = join(root, 'config.json');
  subagents(fake.pi, {
    agentDir: root,
    configPath,
    createRuntime: async () => {
      throw new Error('must not launch');
    },
  });
  const ctx = {
    mode: 'tui',
    hasUI: true,
    cwd: root,
    sessionManager: SessionManager.inMemory(root),
    ui: {
      setWidget() {},
      notify: (message, type) => notes.push({ message, type }),
      custom() {
        throw new Error('must not open a view');
      },
    },
  };
  await fake.fire('session_start', {}, ctx);
  const command = fake.commands.get('subagents');
  assert.doesNotMatch(command.description, /show|stop|auto on|max <|integer/);
  for (const mode of ['tui', 'rpc', 'json', 'print']) {
    for (const args of [
      'show A1',
      'stop A1',
      'settings auto off',
      'settings max 2',
      'settings max 0',
      'list unexpected',
    ]) {
      await command.handler(args, { ...ctx, mode });
      assert.deepEqual(notes.at(-1), { message: 'Usage: /subagents [list|settings]', type: 'warning' });
      assert.deepEqual(await loadSubagentConfig({ path: configPath }), DEFAULT_SUBAGENT_CONFIG);
    }
  }
  await command.handler('settings', { ...ctx, mode: 'rpc' });
  assert.equal(notes.at(-1).message, 'auto on; max 4');
  assert.ok(fake.tools.has('subagent_stop') && fake.tools.has('subagent_result') && fake.tools.has('subagent_list'));
  await fake.fire('session_shutdown', {}, ctx);
});

test('active widget follows the effective concurrency limit and disappears on completion', async () => {
  const running = agent('A1', 'running');
  const widgets = new Map();
  const listeners = new Set();
  const manager = {
    compactAgents: () => [running],
    activeAgentIds: () => (running.run.state === 'running' ? [running.agentId] : []),
    subscribe: callback => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  const ui = createSubagentUI({
    ctx: { mode: 'tui', ui: { setWidget: (id, widget) => (widget ? widgets.set(id, widget) : widgets.delete(id)) } },
    manager,
    getConfig: async () => ({ maxConcurrent: 4 }),
  });
  await ui.ready;
  const status = () =>
    widgets
      .get('subagents-status')({}, { fg: (_name, text) => text })
      .render(80)
      .join(' ');
  assert.match(status(), /1\/4/);
  ui.configChanged({ maxConcurrent: 2 });
  assert.match(status(), /1\/2/);
  running.run.state = 'completed';
  for (const listener of listeners) listener({ agentId: running.agentId, state: 'completed' });
  assert.equal(widgets.has('subagents-status'), false);
  ui.dispose();
});

test('Graphite and subagents retain their distinct widgets in either load order', async t => {
  for (const order of ['graphite-first', 'subagents-first']) {
    const root = await mkdtemp(join(tmpdir(), 'subagents-graphite-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const session = SessionManager.inMemory(root);
    const store = new SubagentStore({ agentDir: root, ownerSessionId: session.getSessionId() });
    await store.saveAgent({
      agentId: '123e4567-e89b-42d3-a456-426614174000',
      ownerSessionId: session.getSessionId(),
      branchId: 'root',
      alias: 'A1',
      title: 'Archived',
      task: 'Read',
      context: '',
      runs: [{ runId: 'run-1', state: 'completed' }],
    });
    const widgets = new Map();
    const fake = createFakePi();
    const ctx = {
      mode: 'tui',
      hasUI: true,
      cwd: root,
      sessionManager: session,
      getContextUsage: () => undefined,
      ui: {
        theme: { fg: (_name, text) => text },
        setTheme: () => ({ success: true }),
        setTitle() {},
        setWorkingIndicator() {},
        setHeader() {},
        setFooter() {},
        notify() {},
        setWidget: (id, component) => (component ? widgets.set(id, component) : widgets.delete(id)),
      },
    };
    const initialize = {
      graphite: () =>
        graphiteUi(fake.pi, { gitReader: async () => ({ state: 'ok', branch: 'main', changedFiles: 0 }) }),
      subagents: () =>
        subagents(fake.pi, {
          agentDir: root,
          configPath: join(root, 'config.json'),
          createRuntime: async () => {
            throw new Error('must not launch');
          },
        }),
    };
    if (order === 'graphite-first') {
      initialize.graphite();
      initialize.subagents();
    } else {
      initialize.subagents();
      initialize.graphite();
    }
    await fake.fire('session_start', { reason: 'startup' }, ctx);
    assert.ok(widgets.has('graphite-ui-timer') && !widgets.has('subagents-status'), order);
    await fake.commands.get('graphite-ui').handler('off', ctx);
    assert.ok(!widgets.has('graphite-ui-timer') && !widgets.has('subagents-status'), order);
    await fake.fire('session_shutdown', { reason: 'quit' }, ctx);
    assert.equal(widgets.size, 0);
  }
});

test('completed agents use a stable factual label without implying validation', () => {
  assert.match(formatStatus([agent('A1', 'running')], { maxConcurrent: 4 }, 120).join(' '), /A1 in progress/);
  assert.equal(formatStatus([agent('A1', 'completed')], { maxConcurrent: 4 }, 120).length, 0);
});

test('untrusted terminal controls are neutralized before styling and missing usage is not zero', () => {
  assert.equal(singleLineText('a\x1b]8;;https://evil\x07b\x1b[31mc\r\n'), 'abc  ');
  const lines = formatStatus([agent('A1', 'awaiting_confirmation', '\x1b[31mDanger')], { maxConcurrent: 4 }, 80);
  assert.match(lines.join(' '), /awaiting confirmation/);
  assert.doesNotMatch(lines.join(' '), /\x1b/);
});
