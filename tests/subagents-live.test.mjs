import assert from 'node:assert/strict';
import test from 'node:test';
import { SubagentManager } from '../packages/subagents/manager.js';
import { LiveSubagentState } from '../packages/subagents/live-state.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sdk } from './fixtures/subagents/host-runtime.mjs';

const { toJsonEvent } = await import(pathToFileURL(join(sdk.getPackageDir(), 'dist/modes/json-event.js')).href);

async function fixture(t) {
  let listener;
  let resolve;
  const persisted = [];
  const manager = new SubagentManager({
    ownerSessionId: 'session',
    branchId: 'branch',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    persist: async value => persisted.push(value),
    createRuntime: async () => ({
      subscribe(callback) {
        listener = callback;
      },
      prompt: async () => ({
        runId: 'runtime',
        result: new Promise(done => {
          resolve = done;
        }),
      }),
      stop: async () => {},
      steer: async () => {},
    }),
  });
  const started = await manager.start({ title: 'Live', task: 'work' });
  t.after(() => manager.shutdown());
  return {
    manager,
    started,
    persisted,
    resolve: value => resolve(value),
    emit: data => listener({ type: 'rpc_event', data }),
    telemetry: data => listener({ type: 'telemetry', data }),
  };
}
const usage = (input, output, cost) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const assistant = (text, used, timestamp = 1) => ({
  role: 'assistant',
  timestamp,
  content: [{ type: 'text', text }],
  usage: used,
});

test('opening mid-stream recovers intact text and partial tool output without persisting it', async t => {
  const view = await fixture(t);
  const message = assistant('## Progress\n\n```js\nconst x = 1;\n```', usage(100, 10, 0.01));
  view.emit({ type: 'message_start', message: assistant('', undefined) });
  view.emit({
    type: 'message_update',
    message,
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: message.content[0].text },
  });
  view.emit({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'README.md' } });
  const partialResult = { content: [{ type: 'text', text: 'line one\nline two' }], details: { count: 2 } };
  view.emit({ type: 'tool_execution_update', toolCallId: 'read-1', toolName: 'read', partialResult });
  const snapshot = view.manager.activitySnapshot(view.started.agentId);
  assert.deepEqual(snapshot.message, message);
  assert.deepEqual(snapshot.tools[0].result, partialResult);
  assert.equal(snapshot.tools[0].isPartial, true);
  snapshot.message.content[0].text = 'mutated';
  assert.equal(view.manager.activitySnapshot(view.started.agentId).message.content[0].text, message.content[0].text);
  assert.equal(JSON.stringify(view.persisted).includes('const x = 1'), false);
});

test('official RPC deltas recover both text fragments and current usage when opening mid-stream', async t => {
  const view = await fixture(t);
  view.emit({ type: 'message_start', message: assistant('', usage(0, 0, 0)) });
  for (const [text, delta, used] of [
    ['first', 'first', usage(100, 1, 0.01)],
    ['first second', ' second', usage(100, 2, 0.02)],
  ]) {
    const message = assistant(text, used);
    const event = toJsonEvent({
      type: 'message_update',
      message,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: message },
    });
    assert.equal(event.message, undefined, 'use the actual snapshot-free RPC protocol');
    view.emit(event);
  }
  const snapshot = view.manager.activitySnapshot(view.started.agentId);
  assert.equal(snapshot.message.content[0].text, 'first second');
  assert.deepEqual(snapshot.message.usage, usage(100, 2, 0.02));
  assert.equal(view.manager.findAgent(view.started.agentId).run.usage.totalTokens, 102);
  assert.equal(view.manager.findAgent(view.started.agentId).run.usage.cost.total, 0.02);
});

test('RPC reconstruction preserves indexed text, thinking and tool calls with authoritative block endings', () => {
  const state = new LiveSubagentState();
  const initial = { ...assistant('', usage(10, 0, 0)), content: [] };
  state.update({ type: 'message_start', message: initial });
  const tool = { type: 'toolCall', id: 'read-1', name: 'read', arguments: {} };
  const partial = { ...initial, content: [{ type: 'text', text: '' }, { type: 'thinking', thinking: '' }, tool] };
  const update = event =>
    state.update(
      toJsonEvent({ type: 'message_update', message: partial, assistantMessageEvent: { ...event, partial } }),
    );
  update({ type: 'text_start', contentIndex: 0 });
  update({ type: 'text_delta', contentIndex: 0, delta: 'partial' });
  update({ type: 'text_end', contentIndex: 0, content: 'authoritative text' });
  update({ type: 'thinking_start', contentIndex: 1 });
  update({ type: 'thinking_delta', contentIndex: 1, delta: 'reasoning' });
  update({ type: 'toolcall_start', contentIndex: 2 });
  update({ type: 'toolcall_delta', contentIndex: 2, delta: '{"path":"README.md"}' });
  let snapshot = state.snapshot('run');
  assert.equal(snapshot.message.content[0].text, 'authoritative text');
  assert.equal(snapshot.message.content[1].thinking, 'reasoning');
  assert.deepEqual(snapshot.message.content[2].arguments, { path: 'README.md' });
  assert.equal(snapshot.message.content[2].id, 'read-1');
  update({ type: 'thinking_end', contentIndex: 1, content: 'authoritative thinking' });
  update({ type: 'toolcall_end', contentIndex: 2, toolCall: { ...tool, arguments: { path: 'final.txt' } } });
  snapshot = state.snapshot('run');
  assert.equal(snapshot.message.content[1].thinking, 'authoritative thinking');
  assert.deepEqual(snapshot.message.content[2], { ...tool, arguments: { path: 'final.txt' } });
});

test('tool intermediate results are delivered to the live view', async t => {
  const view = await fixture(t);
  const received = [];
  view.manager.subscribeActivity(event => received.push(event));
  view.emit({
    type: 'tool_execution_update',
    toolCallId: 'tool',
    partialResult: { content: [{ type: 'text', text: 'running' }] },
  });
  assert.equal(received.at(-1)?.data.type, 'tool_execution_update');
});

test('usage grows across turns, replaces partial usage, and terminal totals are authoritative', async t => {
  const view = await fixture(t);
  view.emit({ type: 'message_end', message: assistant('first', usage(100, 10, 0.01)) });
  view.emit({ type: 'message_start', message: assistant('', undefined, 2) });
  view.emit({ type: 'message_update', message: assistant('second', usage(200, 5, 0.02), 2) });
  assert.equal(view.manager.findAgent(view.started.agentId).run.usage.totalTokens, 315);
  view.emit({ type: 'message_update', message: assistant('second more', usage(200, 10, 0.03), 2) });
  assert.equal(view.manager.findAgent(view.started.agentId).run.usage.totalTokens, 320);
  view.emit({ type: 'message_end', message: assistant('second done', usage(200, 20, 0.04), 2) });
  assert.equal(view.manager.findAgent(view.started.agentId).run.usage.totalTokens, 330);
  assert.equal(view.manager.findAgent(view.started.agentId).run.usage.cost.total, 0.05);
  view.resolve({ status: 'completed', text: 'done', usage: usage(400, 30, 0.07) });
  await view.manager.wait({ agentIds: [view.started.agentId] });
  assert.equal(view.manager.findAgent(view.started.agentId).run.usage.totalTokens, 430);
});

test('context telemetry reaches Informations subscribers without storing streamed content', async t => {
  const view = await fixture(t);
  const changes = [];
  view.manager.subscribe(event => changes.push(event));
  const contextUsage = { tokens: 320, contextWindow: 1000, percent: 32 };
  view.telemetry({ usage: usage(100, 10, 0.01), contextUsage, updatedAt: '2026-01-01T00:00:00Z' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(view.manager.findAgent(view.started.agentId).run.contextUsage, contextUsage);
  assert.equal(changes.at(-1)?.agent.run.usage.totalTokens, 110);
});

test('completed messages retain sampled extra usage without dropping or counting it twice', async t => {
  const view = await fixture(t);
  view.telemetry({ usage: usage(100, 0, 0.1) });
  view.emit({ type: 'message_start', message: assistant('', usage(50, 0, 0.05)) });
  assert.equal(view.manager.findAgent(view.started.agentId).run.usage.totalTokens, 150);
  view.emit({ type: 'message_end', message: assistant('first', usage(50, 0, 0.05)) });
  assert.equal(
    view.manager.findAgent(view.started.agentId).run.usage.totalTokens,
    150,
    'message_end must not lose previously sampled extra consumption',
  );
  view.telemetry({ usage: usage(150, 0, 0.15) });
  assert.equal(
    view.manager.findAgent(view.started.agentId).run.usage.totalTokens,
    150,
    'the sample already includes the first message',
  );
  view.emit({ type: 'message_end', message: assistant('second', usage(40, 0, 0.04), 2) });
  view.telemetry({ contextUsage: { tokens: null, contextWindow: 1000, percent: null } });
  assert.equal(view.manager.findAgent(view.started.agentId).run.usage.totalTokens, 190);
  assert.ok(Math.abs(view.manager.findAgent(view.started.agentId).run.usage.cost.total - 0.19) < 1e-12);
  view.telemetry({ usage: usage(190, 0, 0.19) });
  view.telemetry({ usage: usage(190, 0, 0.19) });
  view.telemetry({ usage: usage(100, 0, 0.1) });
  assert.equal(
    view.manager.findAgent(view.started.agentId).run.usage.totalTokens,
    190,
    'repeated or delayed samples must not change known totals',
  );
});

test('an unavailable telemetry sample preserves previously confirmed counters', async t => {
  const view = await fixture(t);
  view.telemetry({ usage: usage(300, 30, 0.04) });
  view.telemetry({ contextUsage: { tokens: null, contextWindow: 1000, percent: null } });
  assert.equal(view.manager.findAgent(view.started.agentId).run.usage.totalTokens, 330);
  assert.equal(view.manager.findAgent(view.started.agentId).run.usage.cost.total, 0.04);
});

test('parallel active tools keep a bounded whole-record snapshot with an explicit archive cue', () => {
  const state = new LiveSubagentState();
  for (let index = 0; index < 200; index++) {
    const toolCallId = `tool-${index}`;
    state.update({ type: 'tool_execution_start', toolCallId, toolName: 'custom', args: { index } });
    state.update({
      type: 'tool_execution_update',
      toolCallId,
      partialResult: { content: [{ type: 'text', text: 'x'.repeat(20000) }] },
    });
  }
  const snapshot = state.snapshot('run');
  assert.ok(snapshot.tools.length <= 128);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 2.1 * 1024 * 1024);
  assert.equal(snapshot.discarded, true);
  assert.ok(snapshot.tools.some(tool => tool.toolCallId === 'tool-199'));
  assert.ok(
    snapshot.tools.every(tool => tool.result.content[0].text.length === 20000),
    'eviction must not mutilate retained results',
  );
});

test('continuations reset the live snapshot and keep previous run accounting', async t => {
  const view = await fixture(t);
  view.emit({ type: 'message_end', message: assistant('first', usage(100, 10, 0.01)) });
  view.resolve({ status: 'completed', text: 'first', usage: usage(100, 10, 0.01) });
  await view.manager.wait({ agentIds: [view.started.agentId] });
  await view.manager.send({ agentId: view.started.agentId, message: 'continue' });
  const snapshot = view.manager.activitySnapshot(view.started.agentId);
  assert.deepEqual(snapshot.messages, []);
  assert.equal(snapshot.message, undefined);
  assert.equal(view.manager.findAgent(view.started.agentId).runs[0].usage.totalTokens, 110);
});
