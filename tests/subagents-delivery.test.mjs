import assert from 'node:assert/strict';
import test from 'node:test';
import { ResultDelivery, formatSubagentContext } from '../packages/subagents/delivery.js';
import { createFakePi } from './fixtures/fake-pi.mjs';

const agent = { agentId: 'agent-1', alias: 'A1', branchId: 'branch-1', title: 'Inspect' };
const run = { runId: 'run-1', state: 'completed' };

function fixture(entries = []) {
  const { pi, messages: sent, entries: confirmed } = createFakePi();
  const ctx = { isIdle: () => false, signal: undefined };
  const delivery = new ResultDelivery({ pi, ctx, branchIds: new Set(['branch-1']), entries });
  return { delivery, sent, confirmed, pi, ctx };
}

test('a failed send remains pending and can be retried without marking it delivered', () => {
  const { delivery, pi, sent } = fixture();
  const send = pi.sendMessage;
  pi.sendMessage = () => {
    throw new Error('queue unavailable');
  };
  assert.throws(() => delivery.announce(agent, run), /queue unavailable/);
  pi.sendMessage = send;
  delivery.announce(agent, run);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message.content, /unverified/);
});

test('pending delivery is not duplicated; only a message supplied to the parent proves delivery', () => {
  const { delivery, sent, confirmed } = fixture();
  delivery.announce(agent, run);
  delivery.announce(agent, run);
  assert.equal(sent.length, 1);
  delivery.observeContext([{ role: 'custom', customType: 'subagents-result-v1', details: sent[0].message.details }]);
  delivery.announce(agent, run);
  assert.equal(sent.length, 1);
  assert.equal(confirmed[0].customType, 'subagents-delivered-v1');
  const restored = fixture([{ type: 'custom', customType: confirmed[0].customType, data: confirmed[0].data }]);
  restored.delivery.announce(agent, run);
  assert.equal(restored.sent.length, 0);
});

test('an archived result entry without model-context proof is retried after compaction', () => {
  const details = { agentId: agent.agentId, runId: run.runId, branchId: agent.branchId };
  const restored = fixture([{ type: 'custom_message', customType: 'subagents-result-v1', details }]);
  restored.delivery.observeContext([]);
  restored.delivery.retryMissing();
  const reminders = restored.delivery.contextReminders([{ ...agent, runs: [run] }]);
  assert.equal(reminders.length, 1);
  // Another context handler may remove this reminder; never acknowledge
  // the mere production of a context-only message.
  assert.equal(restored.delivery.contextReminders([{ ...agent, runs: [run] }]).length, 1);
  assert.equal(restored.confirmed.length, 0);
  assert.equal(restored.sent.length, 0);
});

test('an appended message excluded from model context by compaction is retried after settlement', () => {
  const { delivery, sent } = fixture();
  delivery.announce(agent, run);
  delivery.observeContext([]);
  delivery.retryMissing();
  const reminders = delivery.contextReminders([{ ...agent, runs: [run] }]);
  assert.equal(reminders.length, 1);
  assert.equal(delivery.contextReminders([{ ...agent, runs: [run] }]).length, 1);
  assert.equal(sent.length, 1);
});

test('a queued message absent from the next model context is retried from the durable terminal run', () => {
  const { delivery, sent } = fixture();
  delivery.announce(agent, run);
  delivery.observeContext([]);
  delivery.retryMissing();
  assert.equal(delivery.contextReminders([{ ...agent, runs: [run] }]).length, 1);
  assert.equal(sent.length, 1);
  delivery.observeContext([{ role: 'custom', customType: 'subagents-result-v1', details: sent[0].message.details }]);
  assert.equal(delivery.contextReminders([{ ...agent, runs: [run] }]).length, 0);
});

test('a branch-local reminder is never queued for delivery to a sibling branch', () => {
  const { delivery, sent } = fixture();
  delivery.announce(agent, run);
  delivery.retryMissing();
  delivery.setBranchIds(new Set(['branch-2']));
  assert.equal(delivery.contextReminders([{ ...agent, runs: [run] }]).length, 0);
  assert.equal(sent.length, 1);
});

test('compact context points to paginated history when older completed run IDs are omitted', () => {
  const runs = Array.from({ length: 11 }, (_, index) => ({ runId: `run-${index}`, state: 'completed' }));
  const text = formatSubagentContext(
    [{ agentId: 'agent-1', alias: 'A1', branchId: 'branch-1', title: 'History', runs }],
    new Set(['branch-1']),
  );
  assert.match(text, /runCount.*11/);
  assert.match(text, /subagent_list.*agentId/);
});

test('model context stays within its byte budget and identifies omitted archives', () => {
  const agents = Array.from({ length: 300 }, (_, index) => ({
    agentId: `agent-${index}`,
    alias: `A${index + 1}`,
    branchId: 'branch-1',
    title: 'Long title '.repeat(100),
    runs: [{ runId: `run-${index}`, state: index === 299 ? 'running' : 'completed', activity: 'working' }],
  }));
  const text = formatSubagentContext(agents, new Set(['branch-1']));
  assert.ok(Buffer.byteLength(text) <= 24 * 1024);
  assert.match(text, /A300/);
  assert.match(text, /omitted|masqu/i);
  assert.match(text, /subagent_list/);
});

test('context-only reminders stay inside their byte budget when results are omitted', () => {
  const { delivery } = fixture();
  const runs = Array.from({ length: 100 }, (_, index) => ({ runId: `run-${index}`, state: 'completed' }));
  const reminders = delivery.contextReminders([{ ...agent, title: 'X'.repeat(160), runs }], 250);
  assert.equal(reminders.length, 1);
  assert.ok(Buffer.byteLength(reminders[0].content) <= 250);
  assert.match(reminders[0].content, /omitted/);
});

test('branch replacement does not deliver old results into a new branch', () => {
  const { delivery, sent } = fixture();
  delivery.setBranchIds(new Set(['branch-2']));
  delivery.announce(agent, run);
  assert.equal(sent.length, 0);
});
