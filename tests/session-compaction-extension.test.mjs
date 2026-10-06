import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { registerSessionCompaction } from '../packages/session-compaction/index.js';
import { createFakePi } from './fixtures/fake-pi.mjs';

async function harness(
  t,
  {
    registry = new Map(),
    parent,
    manager = SessionManager.inMemory(process.cwd()),
    settings = {},
    events = new EventEmitter(),
  } = {},
) {
  parent ??= await mkdtemp(join(tmpdir(), 'compaction-extension-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const states = [];
  const resumes = [];
  const ctx = {
    sessionManager: manager,
    cwd: process.cwd(),
    mode: 'rpc',
    ui: { notify() {} },
    model: { provider: 'test', id: 'model', contextWindow: 100000 },
    getContextUsage: () => ({ tokens: 59000, percent: 59, contextWindow: 100000 }),
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
  const fake = createFakePi({
    events,
    getSettings: () => settings,
    appendEntry: (type, data) => manager.appendCustomEntry(type, data),
    sendMessage: (...args) => resumes.push(args),
  });
  const { pi, tools } = fake;
  events.on('session-compaction:state', state => states.push(state));
  registerSessionCompaction(pi, { tempParent: parent, registry });
  const fire = async (name, event = {}) =>
    fake.handlers.has(name) ? (await fake.fire(name, event, ctx)).at(-1) : undefined;
  const call = (name, params = {}) => tools.get(name).execute('call', params, undefined, undefined, ctx);
  return { pi, ctx, tools, fire, call, states, resumes, parent, registry, manager };
}

test('state uses effective native overrides, preserves settings, and refreshes on request', async t => {
  const settings = { compaction: { reserveTokens: 10000, modelOverrides: { 'test/model': { reserveTokens: 25000 } } } };
  const before = JSON.stringify(settings);
  const h = await harness(t, { settings });
  await h.fire('session_start', { reason: 'startup' });
  assert.deepEqual(h.states.at(-1), { percent: 59, lowPercent: 60, highPercent: 75, phase: 'below', enabled: true });
  h.ctx.getContextUsage = () => ({ tokens: 60000, percent: 60, contextWindow: 100000 });
  h.pi.events.emit('session-compaction:request-state');
  assert.equal(h.states.at(-1).phase, 'available');
  h.ctx.getContextUsage = () => ({ tokens: 75000, percent: 75, contextWindow: 100000 });
  h.pi.events.emit('session-compaction:request-state');
  assert.equal(h.states.at(-1).phase, 'available', 'native threshold is strictly greater than');
  h.ctx.getContextUsage = () => ({ tokens: 75001, percent: 75.001, contextWindow: 100000 });
  await h.fire('message_end');
  assert.equal(h.states.at(-1).phase, 'automatic');
  h.ctx.getContextUsage = () => ({ tokens: null, percent: null, contextWindow: 100000 });
  h.pi.events.emit('session-compaction:request-state');
  assert.equal(h.states.at(-1).phase, 'unknown');
  assert.equal(JSON.stringify(settings), before);
  await h.fire('session_shutdown', { reason: 'quit' });
});

test('invalid native settings report unknown instead of claiming automatic compaction is disabled', async t => {
  const settings = { compaction: { reserveTokens: -1, modelOverrides: { 'test/model': { reserveTokens: 25000 } } } };
  const before = JSON.stringify(settings);
  const h = await harness(t, { settings });
  await h.fire('session_start', { reason: 'startup' });
  assert.equal(h.states.at(-1).enabled, null);
  assert.equal(h.states.at(-1).highPercent, null);
  assert.equal(h.states.at(-1).phase, 'unknown');
  assert.equal(JSON.stringify(settings), before);
  await h.fire('session_shutdown', { reason: 'quit' });
});

test('factory registers tools with no optional event bus or lifecycle resources', () => {
  const { pi, tools } = createFakePi({ events: undefined });
  registerSessionCompaction(pi, { registry: new Map() });
  assert.equal(tools.size, 5);
  for (const tool of tools.values()) assert.ok(tool.promptSnippet);
});

test('curated memory stays outside transcript, index injects only after compaction, targeted reads paginate', async t => {
  const h = await harness(t);
  await h.fire('session_start', { reason: 'startup' });
  const wrote = await h.call('session_memory_write', {
    id: 'constraint',
    title: 'Approved constraint',
    content: 'FACT-ONLY-SECRET\n'.repeat(1000),
  });
  assert.equal(wrote.details.id, 'constraint');
  assert.doesNotMatch(JSON.stringify(h.manager.getBranch()), /FACT-ONLY-SECRET/);
  const initial = await h.fire('context', { messages: [] });
  assert.match(initial.messages[0].content, /59/);
  assert.match(initial.messages[0].content, /remainingPercent/);
  assert.doesNotMatch(initial.messages[0].content, /Approved constraint/);
  h.manager.appendCompaction('NATIVE SUMMARY', null, 70000);
  const injected = await h.fire('context', { messages: [{ role: 'compactionSummary', summary: 'NATIVE SUMMARY' }] });
  assert.equal(injected.messages.length, 2);
  assert.match(injected.messages[1].content, /Approved constraint/);
  assert.doesNotMatch(injected.messages[1].content, /FACT-ONLY-SECRET/);
  const page = await h.call('session_memory_read', { id: 'constraint', offset: 5, limit: 8 });
  assert.equal(page.details.content, 'ONLY-SEC');
  assert.equal(page.details.nextOffset, 13);
  await h.call('session_memory_delete', { id: 'constraint' });
  await assert.rejects(h.call('session_memory_read', { id: 'constraint' }), /not found/);
  await h.fire('session_shutdown', { reason: 'quit' });
  assert.deepEqual(await readdir(h.parent), []);
});

test('concurrent memory mutation cannot overfill the bounded branch index', async t => {
  const h = await harness(t);
  await h.fire('session_start', { reason: 'startup' });
  for (let i = 0; i < 31; i++)
    await h.call('session_memory_write', { id: `note-${i}`, title: 'Facts', content: 'FACTS' });
  const results = await Promise.allSettled(
    ['last-a', 'last-b'].map(id => h.call('session_memory_write', { id, title: 'Facts', content: 'FACTS' })),
  );
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await h.call('session_compaction_status')).details.memory.length, 32);
  await h.fire('session_shutdown', { reason: 'quit' });
});

test('reload preserves memory, tree reconstructs revisions, and session replacement expires it', async t => {
  const h = await harness(t);
  await h.fire('session_start', { reason: 'startup' });
  await h.call('session_memory_write', { id: 'decision', title: 'First', content: 'FIRST' });
  const firstLeaf = h.manager.getLeafId();
  await h.call('session_memory_write', { id: 'decision', title: 'Abandoned', content: 'ABANDONED' });
  h.manager.branch(firstLeaf);
  await h.fire('session_tree');
  assert.equal((await h.call('session_memory_read', { id: 'decision' })).details.content, 'FIRST');
  await h.fire('session_shutdown', { reason: 'reload' });
  const reloaded = await harness(t, { registry: h.registry, parent: h.parent, manager: h.manager });
  await reloaded.fire('session_start', { reason: 'reload' });
  assert.equal((await reloaded.call('session_memory_read', { id: 'decision' })).details.content, 'FIRST');
  await reloaded.fire('session_shutdown', { reason: 'resume' });
  assert.deepEqual(await readdir(h.parent), []);
  const resumed = await harness(t, { registry: h.registry, parent: h.parent, manager: h.manager });
  await resumed.fire('session_start', { reason: 'resume' });
  await assert.rejects(resumed.call('session_memory_read', { id: 'decision' }), /not found/);
  assert.equal((await resumed.call('session_compaction_status')).details.unavailableNotes, 1);
  await resumed.fire('session_shutdown', { reason: 'quit' });
});

test('voluntary request gates at 60%, defers native compaction to safe boundary, and resumes once', async t => {
  const h = await harness(t, { settings: { compaction: { enabled: false } } });
  await h.fire('session_start', { reason: 'startup' });
  let compactCalls = 0;
  let options;
  h.ctx.compact = value => {
    compactCalls++;
    options = value;
  };
  await assert.rejects(h.call('session_compact', { reason: 'Completed investigation' }), /60%/);
  h.ctx.getContextUsage = () => ({ tokens: 60000, percent: 60, contextWindow: 100000 });
  const requested = await h.call('session_compact', { reason: 'Completed investigation' });
  assert.equal(requested.terminate, true);
  assert.equal(compactCalls, 0, 'never call compact during execute');
  assert.equal(h.tools.get('session_compact').exposure, 'model-only');
  await h.fire('agent_before_settle', { outcome: 'completed' });
  assert.equal(compactCalls, 1);
  assert.equal(h.states.at(-1).phase, 'compacting');
  assert.equal(
    await h.fire('session_before_compact', { reason: 'manual' }),
    undefined,
    'does not replace native summary',
  );
  await h.fire('session_compact');
  options.onComplete({});
  options.onComplete({});
  assert.equal(h.resumes.length, 1);
  assert.equal(h.resumes[0][1].triggerTurn, true);
  assert.equal(h.resumes[0][1].deliverAs, 'followUp');
  await h.fire('session_shutdown', { reason: 'quit' });
});

test('native compaction resolves a pending voluntary request without losing its continuation or compacting twice', async t => {
  for (const outcome of ['success', 'failure', 'abort']) {
    const h = await harness(t);
    await h.fire('session_start', { reason: 'startup' });
    h.ctx.getContextUsage = () => ({ tokens: 95000, percent: 95, contextWindow: 100000 });
    let compactCalls = 0;
    h.ctx.compact = () => {
      compactCalls++;
    };
    await h.call('session_compact', { reason: 'Useful boundary' });
    await h.fire('session_before_compact', { reason: 'threshold' });
    if (outcome === 'success') await h.fire('session_compact', { reason: 'threshold' });
    else
      await h.fire('session_compact_failed', {
        reason: 'threshold',
        aborted: outcome === 'abort',
        errorMessage: 'Provider unavailable',
      });
    const boundary = await h.fire('agent_before_settle', { outcome: 'completed' });
    if (outcome === 'abort') assert.equal(boundary, undefined);
    else {
      assert.equal(boundary.continue, true, 'terminate:true still owes one continuation');
      assert.equal(boundary.entries.length, 1);
      assert.match(boundary.entries[0].content, outcome === 'success' ? /completed/ : /failed/);
    }
    assert.equal(compactCalls, 0, 'native terminal outcome must not trigger a second compaction');
    assert.equal(
      await h.fire('agent_before_settle', { outcome: 'completed' }),
      undefined,
      'continuation is consumed once',
    );
    await h.fire('session_shutdown', { reason: 'quit' });
  }
});

test('a naturally started turn consumes pending continuation before or after native compaction', async t => {
  for (const nativeFinished of [false, true]) {
    const h = await harness(t);
    await h.fire('session_start', { reason: 'startup' });
    h.ctx.getContextUsage = () => ({ tokens: 95000, percent: 95, contextWindow: 100000 });
    let compactCalls = 0;
    h.ctx.compact = () => {
      compactCalls++;
    };
    await h.call('session_compact', { reason: 'Original task boundary' });
    if (nativeFinished) await h.fire('session_compact', { reason: 'threshold' });
    await h.fire('turn_start');
    assert.equal(await h.fire('agent_before_settle', { outcome: 'completed' }), undefined);
    assert.equal(compactCalls, 0, 'never compact again or resurrect the task after natural continuation');
    assert.equal(h.resumes.length, 0);
    assert.equal((await h.call('session_compaction_status')).details.pending, false);
    await h.fire('session_shutdown', { reason: 'quit' });
  }
});

test('a naturally started turn suppresses a late manual compaction callback too', async t => {
  const h = await harness(t);
  await h.fire('session_start', { reason: 'startup' });
  h.ctx.getContextUsage = () => ({ tokens: 70000, percent: 70, contextWindow: 100000 });
  let options;
  h.ctx.compact = value => {
    options = value;
  };
  await h.call('session_compact', { reason: 'Original task boundary' });
  await h.fire('agent_before_settle', { outcome: 'completed' });
  await h.fire('session_compact', { reason: 'manual' });
  await h.fire('turn_start');
  options.onComplete({});
  options.onComplete({});
  assert.equal(h.resumes.length, 0, 'a callback must not add Continue the original task after another turn');
  await h.fire('session_shutdown', { reason: 'quit' });
});

test('failed/cancelled compaction, tree changes, automatic success and one-shot shutdown cannot resume stale work', async t => {
  const h = await harness(t);
  await h.fire('session_start', { reason: 'startup' });
  h.ctx.getContextUsage = () => ({ tokens: 60000, percent: 60, contextWindow: 100000 });
  let options;
  h.ctx.compact = value => {
    options = value;
  };
  await h.call('session_compact', { reason: 'Useful boundary' });
  await h.fire('session_tree');
  await h.fire('agent_before_settle', { outcome: 'completed' });
  assert.equal(options, undefined);
  await h.call('session_compact', { reason: 'Useful boundary' });
  await h.fire('session_compact', { reason: 'threshold' });
  await h.fire('agent_before_settle', { outcome: 'completed' });
  assert.equal(options, undefined);
  await h.call('session_compact', { reason: 'Useful boundary' });
  await h.fire('agent_before_settle', { outcome: 'aborted' });
  assert.equal(options, undefined);
  h.ctx.mode = 'json';
  await assert.rejects(h.call('session_compact', { reason: 'Useful boundary' }), /one-shot/);
  h.ctx.mode = 'rpc';
  await h.call('session_compact', { reason: 'Useful boundary' });
  await h.fire('agent_before_settle', { outcome: 'completed' });
  await h.fire('session_tree');
  options.onComplete({});
  assert.equal(h.resumes.length, 0, 'tree navigation suppresses an old branch continuation');
  await h.call('session_compact', { reason: 'Useful boundary' });
  await h.fire('agent_before_settle', { outcome: 'completed' });
  options.onError(new Error('Compaction cancelled'));
  assert.equal(h.resumes.length, 0);
  await h.call('session_compact', { reason: 'Useful boundary' });
  await h.fire('agent_before_settle', { outcome: 'completed' });
  options.onError(new Error('Provider unavailable'));
  assert.equal(h.resumes.length, 1);
  await h.call('session_compact', { reason: 'Useful boundary' });
  await h.fire('agent_before_settle', { outcome: 'completed' });
  await h.fire('session_shutdown', { reason: 'quit' });
  options.onComplete({});
  assert.equal(h.resumes.length, 1);
});

test('explicit native abort outcome suppresses continuation regardless of error wording', async t => {
  const h = await harness(t);
  await h.fire('session_start', { reason: 'startup' });
  h.ctx.getContextUsage = () => ({ tokens: 70000, percent: 70, contextWindow: 100000 });
  let options;
  h.ctx.compact = value => {
    options = value;
  };
  await h.call('session_compact', { reason: 'Useful boundary' });
  await h.fire('agent_before_settle', { outcome: 'completed' });
  await h.fire('session_compact_failed', {
    reason: 'manual',
    aborted: true,
    errorMessage: 'Summarization failed: connection terminated',
  });
  options.onError(new Error('Summarization failed: connection terminated'));
  assert.equal(h.resumes.length, 0);
  await h.call('session_compact', { reason: 'Useful boundary' });
  await h.fire('agent_before_settle', { outcome: 'completed' });
  await h.fire('session_compact_failed', {
    reason: 'manual',
    aborted: false,
    errorMessage: 'Cancellation service unavailable',
  });
  options.onError(new Error('Cancellation service unavailable'));
  assert.equal(h.resumes.length, 1, 'explicit non-abort remains an ordinary failure despite cancellation wording');
  await h.fire('session_shutdown', { reason: 'quit' });
});

test('fork transfers only notes on the selected branch, then removes outgoing storage', async t => {
  const h = await harness(t);
  await h.fire('session_start', { reason: 'startup' });
  await h.call('session_memory_write', { id: 'decision', title: 'First', content: 'FIRST' });
  const first = h.manager.getBranch();
  await h.call('session_memory_write', { id: 'decision', title: 'Later', content: 'ABANDONED' });
  await h.fire('session_shutdown', { reason: 'fork' });
  const manager = SessionManager.inMemory(process.cwd(), {}, first);
  const forked = await harness(t, { registry: h.registry, parent: h.parent, manager });
  await forked.fire('session_start', { reason: 'fork' });
  assert.equal((await forked.call('session_memory_read', { id: 'decision' })).details.content, 'FIRST');
  assert.equal((await readdir(h.parent)).length, 1);
  await forked.fire('session_shutdown', { reason: 'quit' });
  assert.deepEqual(await readdir(h.parent), []);
});
