import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { RpcClient, SessionManager } from '@earendil-works/pi-coding-agent';
import subagentsExtension from '../packages/subagents/index.js';
import * as parentSdk from '@earendil-works/pi-coding-agent';
import { cli } from './fixtures/subagents/host-runtime.mjs';
import { SubagentStore } from '../packages/subagents/store.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePi } from './fixtures/fake-pi.mjs';

// These fake parent contexts use the SDK imported by this embedding.
const subagents = (pi, options) => subagentsExtension(pi, { sdk: parentSdk, ...options });
const here = dirname(fileURLToPath(import.meta.url));
const deterministicProviderPath = join(here, 'fixtures/subagents/deterministic-provider.js');
const subagentsPath = join(here, '../packages/subagents/index.js');

// The parent exposes no tools of its own to the delegated agents.
const fakePi = (overrides = {}) => createFakePi({ getAllTools: () => [], getActiveTools: () => [], ...overrides });

function context() {
  return {
    cwd: process.cwd(),
    mode: 'print',
    hasUI: false,
    signal: undefined,
    model: undefined,
    thinkingLevel: 'off',
    modelRegistry: {},
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => 'session-1',
      getLeafId: () => 'branch-1',
      isPersisted: () => true,
      getEntries: () => [],
    },
    ui: { notify: () => {} },
  };
}

test('registers the user entry point, installs seven tools and stops its session manager on shutdown', async t => {
  const agentDir = await mkdtemp(`${tmpdir()}/subagent-lifecycle-`);
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const fake = fakePi();
  subagents(fake.pi, {
    agentDir,
    createRuntime: async () => ({
      prompt: async () => ({ runId: 'r', result: Promise.resolve({ status: 'completed', text: 'ok' }) }),
      stop: async () => {},
    }),
  });
  assert.equal(fake.tools.size, 7);
  assert.ok(fake.commands.has('subagents'));
  const packageJson = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8'));
  assert.ok(packageJson.pi.extensions.includes('./packages/subagents/index.js'));
  const ctx = context();
  await fake.fire('session_start', { reason: 'startup' }, ctx);
  await fake.fire('session_shutdown', { reason: 'quit' }, ctx);
  await assert.rejects(
    fake.tools.get('subagent_start').execute('x', { title: 'x', task: 'x', context: '' }, undefined, undefined, ctx),
    /not active/i,
  );
});

test('failed session shutdown retains the manager for a cleanup retry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-shutdown-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakePi();
  let stops = 0;
  subagents(fake.pi, {
    agentDir: root,
    configPath: join(root, 'config.json'),
    createRuntime: async () => ({
      prompt: async () => ({ runId: 'worker', result: new Promise(() => {}) }),
      stop: async () => {
        if (++stops <= 2) throw new Error('process still alive');
      },
    }),
  });
  const ctx = {
    ...context(),
    cwd: root,
    isIdle: () => false,
    model: {
      provider: 'openai',
      id: 'fixture',
      api: 'openai-completions',
      baseUrl: 'https://example.test/v1',
      input: ['text'],
    },
    sessionManager: SessionManager.inMemory(root),
  };
  await fake.fire('session_start', {}, ctx);
  const start = fake.tools.get('subagent_start');
  await start.execute('start', { title: 'Active', task: 'work', context: '' }, undefined, undefined, ctx);
  await assert.rejects(fake.fire('session_shutdown', {}, ctx), /process still alive/);
  const list = fake.tools.get('subagent_list');
  assert.equal((await list.execute('list', {}, undefined, undefined, ctx)).details.items[0].run.state, 'stopping');
  await fake.fire('session_shutdown', {}, ctx);
  assert.equal(stops, 3);
  await assert.rejects(list.execute('list', {}, undefined, undefined, ctx), /not active/i);
});

test('a resumed session cannot hide a worker whose cleanup is still failing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-switch-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakePi();
  let stops = 0;
  subagents(fake.pi, {
    agentDir: root,
    configPath: join(root, 'config.json'),
    createRuntime: async () => ({
      prompt: async () => ({ runId: 'worker', result: new Promise(() => {}) }),
      stop: async () => {
        if (++stops <= 4) throw new Error('process still alive');
      },
    }),
  });
  const sessionManager = SessionManager.create(root, root);
  const ctx = {
    ...context(),
    cwd: root,
    isIdle: () => false,
    model: {
      provider: 'openai',
      id: 'fixture',
      api: 'openai-completions',
      baseUrl: 'https://example.test/v1',
      input: ['text'],
    },
    sessionManager,
  };
  await fake.fire('session_start', {}, ctx);
  await fake.tools
    .get('subagent_start')
    .execute('start', { title: 'Active', task: 'work', context: '' }, undefined, undefined, ctx);
  await assert.rejects(fake.fire('session_shutdown', {}, ctx), /process still alive/);
  const resumed = { ...ctx, sessionManager };
  await assert.rejects(fake.fire('session_start', {}, resumed), /cleanup failed|process still alive/);
  assert.equal(stops, 4);
  const list = fake.tools.get('subagent_list');
  await assert.rejects(list.execute('list', {}, undefined, undefined, resumed), /not active/i);
  await assert.rejects(
    fake.tools
      .get('subagent_start')
      .execute('start', { title: 'Blocked', task: 'work', context: '' }, undefined, undefined, resumed),
    /not active/i,
  );
  await fake.fire('session_shutdown', {}, resumed);
  assert.equal(stops, 5);
  await fake.fire('session_start', {}, resumed);
  const archived = (await list.execute('list', {}, undefined, undefined, resumed)).details.items;
  assert.equal(archived[0].run.state, 'cancelled');
  await fake.fire('session_shutdown', {}, resumed);
});

test('session start restores intact archives and warns about each damaged archive', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SubagentStore({ agentDir: root, ownerSessionId: 'session-1' });
  const goodId = '123e4567-e89b-42d3-a456-426614174000';
  const badId = '223e4567-e89b-42d3-a456-426614174000';
  const malformedId = '323e4567-e89b-42d3-a456-426614174000';
  const invalidAliasId = '023e4567-e89b-42d3-a456-426614174000';
  await store.saveAgent({
    agentId: goodId,
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    alias: 'A1',
    title: 'Intact',
    runs: [],
  });
  await writeFile(join(await store.ensureAgentDirectory(badId), 'metadata.json'), '{broken');
  await writeFile(
    join(await store.ensureAgentDirectory(malformedId), 'metadata.json'),
    JSON.stringify({
      version: 1,
      agent: {
        agentId: malformedId,
        ownerSessionId: 'session-1',
        branchId: 'branch-1',
        alias: 'A2',
        title: 'Malformed',
        runs: {},
      },
    }),
  );
  await writeFile(
    join(await store.ensureAgentDirectory(invalidAliasId), 'metadata.json'),
    JSON.stringify({
      version: 1,
      agent: {
        agentId: invalidAliasId,
        ownerSessionId: 'session-1',
        branchId: 'branch-1',
        alias: null,
        title: 'Invalid alias',
        runs: [],
      },
    }),
  );
  const fake = fakePi();
  subagents(fake.pi, {
    agentDir: root,
    createRuntime: async () => {
      throw new Error('must not start');
    },
  });
  const warnings = [];
  const ctx = { ...context(), hasUI: true, ui: { notify: (message, type) => warnings.push({ message, type }) } };
  await fake.fire('session_start', {}, ctx);
  const listed = await fake.tools.get('subagent_list').execute('list', {}, undefined, undefined, ctx);
  assert.deepEqual(
    listed.details.items.map(item => item.agentId),
    [goodId],
  );
  await fake.commands.get('subagents').handler('list', ctx);
  assert.ok(warnings.some(warning => warning.message.includes('Intact')));
  assert.equal(warnings.filter(warning => warning.type === 'warning').length, 3);
  assert.ok(warnings.some(warning => warning.message.includes(badId)));
  assert.ok(warnings.some(warning => warning.message.includes(malformedId)));
  assert.ok(warnings.some(warning => warning.message.includes(invalidAliasId)));
  await fake.fire('session_shutdown', {}, ctx);
});

test('a restored undelivered result retains its compact preview without starting a worker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-preview-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SubagentStore({ agentDir: root, ownerSessionId: 'session-1' });
  const agentId = '123e4567-e89b-42d3-a456-426614174000';
  const runId = '223e4567-e89b-42d3-a456-426614174000';
  await store.saveResult(agentId, runId, 'ARCHIVED_EVIDENCE');
  await store.saveAgent({
    agentId,
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    alias: 'A1',
    title: 'Recovered',
    runs: [{ runId, state: 'completed', resultStored: true, resultPreview: 'ARCHIVED_EVIDENCE' }],
  });
  const fake = fakePi();
  subagents(fake.pi, {
    agentDir: root,
    createRuntime: async () => {
      throw new Error('archive must not start a worker');
    },
  });
  const ctx = { ...context(), isIdle: () => false };
  await fake.fire('session_start', {}, ctx);
  assert.equal(fake.messages.length, 1);
  assert.equal(fake.messages[0].message.details.preview, 'ARCHIVED_EVIDENCE');
  assert.doesNotMatch(fake.messages[0].message.content, /ARCHIVED_EVIDENCE/);
  await fake.fire('session_shutdown', {}, ctx);
});

test('restored session hides completion cards for runs previously read by the parent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-read-cards-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakePi();
  subagents(fake.pi, {
    agentDir: root,
    createRuntime: async () => {
      throw new Error('must not launch');
    },
  });
  const ctx = context();
  ctx.sessionManager = {
    ...ctx.sessionManager,
    getBranch: () => [
      {
        type: 'message',
        id: 'tool-entry',
        message: {
          role: 'toolResult',
          toolName: 'subagent_result',
          isError: false,
          details: { agentId: 'agent-1', runId: 'run-1', state: 'completed', text: 'EVIDENCE' },
        },
      },
    ],
  };
  await fake.fire('session_start', {}, ctx);
  const render = fake.messageRenderers.get('subagents-result-v1');
  const theme = { fg: (_name, text) => text };
  assert.deepEqual(
    render({ details: { agentId: 'agent-1', runId: 'run-1', state: 'completed' } }, {}, theme).render(80),
    [],
  );
  assert.match(
    render({ details: { agentId: 'agent-1', runId: 'run-2', state: 'completed' }, content: 'unread' }, {}, theme)
      .render(80)
      .join(' '),
    /unread/,
  );
  await fake.fire('session_shutdown', {}, ctx);
});

test('tree navigation restores completion cards when the read occurred only on another branch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-read-branch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakePi();
  subagents(fake.pi, {
    agentDir: root,
    createRuntime: async () => {
      throw new Error('must not launch');
    },
  });
  let current = 'leaf-read';
  const readEntry = {
    type: 'message',
    id: 'read-entry',
    message: {
      role: 'toolResult',
      toolName: 'subagent_result',
      isError: false,
      details: { agentId: 'agent-1', runId: 'run-1', state: 'completed', text: 'EVIDENCE' },
    },
  };
  const ctx = context();
  ctx.sessionManager = {
    ...ctx.sessionManager,
    getLeafId: () => current,
    getBranch: () => (current === 'leaf-read' ? [{ id: 'ancestor' }, readEntry] : [{ id: 'ancestor' }]),
  };
  await fake.fire('session_start', {}, ctx);
  const render = fake.messageRenderers.get('subagents-result-v1');
  const message = { details: { agentId: 'agent-1', runId: 'run-1', state: 'completed' }, content: 'unread' };
  const theme = { fg: (_name, text) => text };
  assert.deepEqual(render(message, {}, theme).render(80), []);
  current = 'ancestor';
  await fake.fire('session_tree', {}, ctx);
  assert.match(render(message, {}, theme).render(80).join(' '), /unread/);
  await fake.fire('session_shutdown', {}, ctx);
});

test('an RPC child editor request is refused without opening an uncancellable parent editor', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-dialog-deadline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakePi();
  let subscriber;
  let respond;
  let editorOpened = false;
  const response = new Promise(resolve => {
    respond = resolve;
  });
  subagents(fake.pi, {
    agentDir: root,
    configPath: join(root, 'config.json'),
    dialogTimeoutMs: 10,
    createRuntime: async () => ({
      subscribe: callback => {
        subscriber = callback;
      },
      prompt: async () => ({ runId: 'worker', result: new Promise(() => {}) }),
      respondUi: async value => respond(value),
      stop: async () => {},
    }),
  });
  const ctx = {
    cwd: root,
    mode: 'rpc',
    hasUI: true,
    signal: undefined,
    thinkingLevel: 'off',
    model: {
      provider: 'openai',
      id: 'fixture',
      api: 'openai-completions',
      baseUrl: 'https://example.test/v1',
      input: ['text'],
    },
    modelRegistry: {},
    isProjectTrusted: () => false,
    isIdle: () => false,
    sessionManager: SessionManager.inMemory(root),
    ui: {
      notify: () => {},
      editor: () => {
        editorOpened = true;
        return new Promise(() => {});
      },
    },
  };
  await fake.fire('session_start', {}, ctx);
  await fake.tools
    .get('subagent_start')
    .execute('start', { title: 'Dialog', task: 'work', context: '' }, undefined, undefined, ctx);
  subscriber({
    type: 'rpc_event',
    data: { type: 'extension_ui_request', method: 'editor', id: 'child-dialog', title: 'edit' },
  });
  assert.deepEqual(await response, { id: 'child-dialog', cancelled: true });
  assert.equal(editorOpened, false);
  await fake.fire('session_shutdown', {}, ctx);
});

test('agent_end waits for work but releases its barrier when the parent is aborted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-barrier-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakePi();
  let stopped = false;
  subagents(fake.pi, {
    agentDir: root,
    configPath: join(root, 'config.json'),
    createRuntime: async () => ({
      prompt: async () => ({ runId: 'worker', result: new Promise(() => {}) }),
      stop: async () => {
        stopped = true;
      },
    }),
  });
  const controller = new AbortController();
  const ctx = {
    cwd: root,
    mode: 'print',
    hasUI: false,
    signal: controller.signal,
    thinkingLevel: 'off',
    model: {
      provider: 'openai',
      id: 'fixture',
      api: 'openai-completions',
      baseUrl: 'https://example.test/v1',
      input: ['text'],
    },
    modelRegistry: {},
    isProjectTrusted: () => false,
    isIdle: () => false,
    sessionManager: SessionManager.inMemory(root),
    ui: { notify: () => {} },
  };
  await fake.fire('session_start', {}, ctx);
  const start = fake.tools.get('subagent_start');
  await start.execute('start', { title: 'Active', task: 'work', context: '' }, undefined, undefined, ctx);
  let settled = false;
  const barrier = fake.fire('agent_end', {}, ctx).then(() => {
    settled = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  controller.abort();
  await barrier;
  assert.equal(stopped, false);
  await fake.fire('session_shutdown', {}, ctx);
  assert.equal(stopped, true);
});

test('tree navigation preserves a still-visible ancestor mission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-tree-ancestor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionManager = SessionManager.inMemory(root);
  sessionManager.appendMessage({ role: 'user', content: 'ancestor', timestamp: Date.now() });
  const fake = fakePi();
  let stopped = false;
  subagents(fake.pi, {
    agentDir: root,
    configPath: join(root, 'config.json'),
    createRuntime: async () => ({
      prompt: async () => ({ runId: 'worker', result: new Promise(() => {}) }),
      stop: async () => {
        stopped = true;
      },
    }),
  });
  const ctx = {
    cwd: root,
    mode: 'tui',
    hasUI: false,
    signal: undefined,
    thinkingLevel: 'off',
    model: {
      provider: 'openai',
      id: 'fixture',
      api: 'openai-completions',
      baseUrl: 'https://example.test/v1',
      input: ['text'],
    },
    modelRegistry: {},
    isProjectTrusted: () => false,
    isIdle: () => false,
    sessionManager,
    ui: { notify: () => {} },
  };
  await fake.fire('session_start', {}, ctx);
  const first = (
    await fake.tools
      .get('subagent_start')
      .execute('start', { title: 'Ancestor', task: 'work', context: '' }, undefined, undefined, ctx)
  ).details;
  sessionManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'descendant' }],
    timestamp: Date.now(),
  });
  await fake.fire('session_tree', {}, ctx);
  assert.equal(stopped, false);
  assert.equal(
    (await fake.tools.get('subagent_list').execute('list', {}, undefined, undefined, ctx)).details.items[0].agentId,
    first.agentId,
  );
  await fake.fire('session_shutdown', {}, ctx);
  assert.equal(stopped, true);
});

test('tree navigation stops the abandoned branch and anchors new work to the selected Pi leaf', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionManager = SessionManager.inMemory(root);
  const rootLeaf = sessionManager.appendMessage({ role: 'user', content: 'root', timestamp: Date.now() });
  sessionManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'old branch' }],
    timestamp: Date.now(),
  });
  const oldLeaf = sessionManager.getLeafId();
  const fake = fakePi();
  const children = [];
  subagents(fake.pi, {
    agentDir: root,
    configPath: join(root, 'subagents.json'),
    createRuntime: async () => {
      const child = {
        prompt: async () => ({ runId: 'running', result: new Promise(() => {}) }),
        stop: async () => {
          child.stopped = true;
        },
      };
      children.push(child);
      return child;
    },
  });
  const ctx = {
    cwd: root,
    mode: 'tui',
    hasUI: false,
    signal: undefined,
    thinkingLevel: 'off',
    model: {
      provider: 'openai',
      id: 'fixture',
      api: 'openai-completions',
      baseUrl: 'https://example.test/v1',
      input: ['text'],
    },
    modelRegistry: {},
    isProjectTrusted: () => false,
    isIdle: () => false,
    sessionManager,
    ui: { notify: () => {} },
  };
  await fake.fire('session_start', { reason: 'startup' }, ctx);
  const start = fake.tools.get('subagent_start');
  const first = (
    await start.execute('one', { title: 'Old branch', task: 'work', context: '' }, undefined, undefined, ctx)
  ).details;
  assert.equal(fake.entries.at(-1).data.branchId, oldLeaf);
  sessionManager.branch(rootLeaf);
  sessionManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'new branch' }],
    timestamp: Date.now(),
  });
  const newLeaf = sessionManager.getLeafId();
  await fake.fire('session_tree', { oldLeafId: oldLeaf, newLeafId: newLeaf }, ctx);
  assert.equal(children[0].stopped, true);
  assert.equal(
    fake.messages.some(({ message }) => message.details?.agentId === first.agentId),
    false,
  );
  const send = fake.tools.get('subagent_send');
  await assert.rejects(
    send.execute('old', { agentId: first.agentId, message: 'resume abandoned branch' }, undefined, undefined, ctx),
    /branch/i,
  );
  const second = (
    await start.execute('two', { title: 'New branch', task: 'work', context: '' }, undefined, undefined, ctx)
  ).details;
  assert.notEqual(first.agentId, second.agentId);
  assert.equal(fake.entries.at(-1).data.branchId, newLeaf);
  const [visibleContext] = await fake.fire('context', { messages: [] }, ctx);
  assert.ok(visibleContext.messages.at(-1).content.includes(second.agentId));
  assert.equal(visibleContext.messages.at(-1).content.includes(first.agentId), false);
  await fake.fire('session_shutdown', { reason: 'quit' }, ctx);
  assert.equal(children[1].stopped, true);
});

test('parent state entries keep a bounded recent run index after many continuations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-state-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakePi();
  subagents(fake.pi, {
    agentDir: root,
    configPath: join(root, 'config.json'),
    createRuntime: async () => ({
      prompt: async () => ({
        runId: 'worker',
        result: Promise.resolve({
          status: 'completed',
          text: 'ok',
          sessionStats: { sessionFile: '/private/child.jsonl' },
        }),
      }),
      stop: async () => {},
    }),
  });
  const ctx = {
    cwd: root,
    mode: 'print',
    hasUI: false,
    signal: undefined,
    thinkingLevel: 'off',
    model: {
      provider: 'openai',
      id: 'fixture',
      api: 'openai-completions',
      baseUrl: 'https://example.test/v1',
      input: ['text'],
    },
    modelRegistry: {
      find: () => ({
        provider: 'openai',
        id: 'fixture',
        api: 'openai-completions',
        baseUrl: 'https://example.test/v1',
        input: ['text'],
      }),
    },
    isProjectTrusted: () => false,
    isIdle: () => false,
    sessionManager: SessionManager.inMemory(root),
    ui: { notify: () => {} },
  };
  await fake.fire('session_start', {}, ctx);
  const start = fake.tools.get('subagent_start');
  const send = fake.tools.get('subagent_send');
  const wait = fake.tools.get('subagent_wait');
  const first = (
    await start.execute('first', { title: 'History', task: 'work', context: '' }, undefined, undefined, ctx)
  ).details;
  await wait.execute('wait', { agentIds: [first.agentId] }, undefined, undefined, ctx);
  for (let index = 0; index < 14; index += 1) {
    await send.execute('send', { agentId: first.agentId, message: `more ${index}` }, undefined, undefined, ctx);
    await wait.execute('wait', { agentIds: [first.agentId] }, undefined, undefined, ctx);
  }
  const entries = fake.entries.filter(entry => entry.customType === 'subagents-state-v1').map(entry => entry.data);
  assert.ok(entries.length > 15);
  assert.ok(entries.every(entry => entry.agent.runs.length <= 10));
  assert.equal(entries.at(-1).agent.runCount, 15);
  const history = fake.tools.get('subagent_list');
  assert.equal(
    (await history.execute('list', { agentId: first.agentId }, undefined, undefined, ctx)).details.items[0].runId,
    first.runId,
  );
  await fake.fire('session_shutdown', {}, ctx);
});

test('tree navigation also stops an active child after fifty archived agents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-tree-page-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionManager = SessionManager.inMemory(root);
  const rootLeaf = sessionManager.appendMessage({ role: 'user', content: 'root', timestamp: Date.now() });
  sessionManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'old branch' }],
    timestamp: Date.now(),
  });
  const fake = fakePi();
  const children = [];
  subagents(fake.pi, {
    agentDir: root,
    configPath: join(root, 'subagents.json'),
    createRuntime: async () => {
      const child = {
        prompt: async () => ({
          runId: 'run',
          result: new Promise(resolve => {
            child.resolve = resolve;
          }),
        }),
        stop: async () => {
          child.stopped = true;
          child.resolve?.({ status: 'aborted' });
        },
      };
      children.push(child);
      return child;
    },
  });
  const ctx = {
    cwd: root,
    mode: 'tui',
    hasUI: false,
    signal: undefined,
    thinkingLevel: 'off',
    model: {
      provider: 'openai',
      id: 'fixture',
      api: 'openai-completions',
      baseUrl: 'https://example.test/v1',
      input: ['text'],
    },
    modelRegistry: {},
    isProjectTrusted: () => false,
    isIdle: () => false,
    sessionManager,
    ui: { notify: () => {} },
  };
  await fake.fire('session_start', { reason: 'startup' }, ctx);
  const start = fake.tools.get('subagent_start');
  const wait = fake.tools.get('subagent_wait');
  for (let index = 0; index < 50; index += 1) {
    const agent = (
      await start.execute('start', { title: `Archived ${index}`, task: 'work', context: '' }, undefined, undefined, ctx)
    ).details;
    children.at(-1).resolve({ status: 'completed', text: 'done' });
    await wait.execute('wait', { agentIds: [agent.agentId] }, undefined, undefined, ctx);
  }
  await start.execute('active', { title: 'Active', task: 'work', context: '' }, undefined, undefined, ctx);
  sessionManager.branch(rootLeaf);
  sessionManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'new branch' }],
    timestamp: Date.now(),
  });
  await fake.fire('session_tree', {}, ctx);
  assert.equal(children.at(-1).stopped, true);
  await fake.fire('session_shutdown', {}, ctx);
});

test('a real RPC parent delegates, waits for the child and receives an unverified result notification', async t => {
  const root = await mkdtemp(`${tmpdir()}/subagent-parent-rpc-`);
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const messages = JSON.stringify(payload.messages);
    const send = (delta, finishReason) =>
      response.write(
        `data: ${JSON.stringify({
          id: `parent-${requests.length}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deterministic',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (messages.includes('Delegated mission')) {
      send({ role: 'assistant', content: 'child evidence' }, 'stop');
    } else if (messages.includes('Result available (unverified)')) {
      send({ role: 'assistant', content: 'parent integrated child evidence' }, 'stop');
    } else if (payload.messages.some(message => message.role === 'tool')) {
      send({ role: 'assistant', content: 'parent provisional' }, 'stop');
    } else if (messages.includes('DELEGATE_NOW')) {
      send(
        {
          role: 'assistant',
          tool_calls: [
            { index: 0, id: 'delegate', type: 'function', function: { name: 'subagent_start', arguments: '' } },
          ],
        },
        null,
      );
      send(
        {
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: JSON.stringify({ title: 'Evidence', task: 'return evidence', context: 'selected only' }),
              },
            },
          ],
        },
        'tool_calls',
      );
    } else {
      send({ role: 'assistant', content: 'parent provisional' }, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new RpcClient({
    cliPath: cli,
    cwd: root,
    env: {
      PI_CODING_AGENT_DIR: join(root, 'agent'),
      HOME: root,
      PI_OFFLINE: '1',
      SUBAGENT_TEST_PROVIDER_URL: `http://127.0.0.1:${server.address().port}/v1`,
    },
    model: 'subagent-test/deterministic',
    args: [
      '--no-extensions',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--session-dir',
      join(root, 'sessions'),
      '-e',
      deterministicProviderPath,
      '-e',
      subagentsPath,
    ],
  });
  t.after(async () => {
    await client.stop().catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await client.start();
  const events = await client.promptAndWait('DELEGATE_NOW', undefined, 30_000);
  const messages = events
    .filter(event => event.type === 'message_end')
    .map(event => event.message)
    .filter(message => message?.role === 'assistant');
  assert.ok(messages.some(message => message.content.some(block => block.text === 'parent integrated child evidence')));
  assert.ok(requests.some(payload => JSON.stringify(payload.messages).includes('Result available (unverified)')));
});
