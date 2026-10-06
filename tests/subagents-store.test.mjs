import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SubagentStore } from '../packages/subagents/store.js';
import { SubagentManager } from '../packages/subagents/manager.js';

test('manager instructions survive private storage and restoration, including live steer additions', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-instructions-'));
  t.after(async () => {
    await manager.shutdown();
    await rm(agentDir, { recursive: true, force: true });
  });
  const store = new SubagentStore({ agentDir, ownerSessionId: 'session-1' });
  let settle;
  const options = {
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => ({
      prompt: async () => ({
        runId: 'runtime',
        result: new Promise(resolve => {
          settle = resolve;
        }),
      }),
      steer: async () => {},
      stop: async () => {},
    }),
    persist: agent => store.saveAgent(agent),
  };
  const manager = new SubagentManager(options);
  const first = await manager.start({
    title: 'Archive instructions',
    task: 'initial é',
    context: 'not an instruction',
    selectionSource: { model: 'défini', reasoning: 'hérité', tools: 'hérités' },
  });
  await manager.send({ agentId: first.agentId, message: 'first addition' });
  assert.deepEqual((await store.loadAgent(first.agentId)).runs[0].instructions, ['initial é', 'first addition']);
  settle({ status: 'completed', text: 'done' });
  await manager.wait({ agentIds: [first.agentId] });
  await manager.send({ agentId: first.agentId, message: 'follow up' });
  await manager.send({ agentId: first.agentId, message: 'second addition' });
  const restored = new SubagentManager(options);
  restored.restore(await store.loadAgents());
  assert.deepEqual(restored.findAgent('A1').selectionSource, {
    model: 'défini',
    reasoning: 'hérité',
    tools: 'hérités',
  });
  assert.deepEqual(
    restored.findAgent('A1').runs.map(run => run.instructions),
    [
      ['initial é', 'first addition'],
      ['follow up', 'second addition'],
    ],
  );
  assert.equal(restored.compactAgents()[0].run.instructions, undefined);
});

test('stores versioned metadata and Unicode results privately before paginated reads', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-store-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const store = new SubagentStore({ agentDir, ownerSessionId: 'session-1' });
  const agent = {
    agentId: '123e4567-e89b-12d3-a456-426614174000',
    alias: 'A1',
    ownerSessionId: 'session-1',
    branchId: 'branch',
    title: 'Unicode',
    task: 'inspect',
    context: 'selected',
    runs: [],
  };
  await store.saveAgent(agent);
  await store.saveResult(agent.agentId, 'run-1', 'é😀\n'.repeat(10_000));
  const page = await store.readResult(agent.agentId, 'run-1', { cursor: 0, maxBytes: 200 });
  assert.match(page.text, /é😀/);
  assert.equal(page.truncated, true);
  assert.ok(page.nextCursor > 0);
  const metadataPath = join(agentDir, 'subagents', 'session-1', agent.agentId, 'metadata.json');
  assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(agentDir, 'subagents', 'session-1', agent.agentId))).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(metadataPath, 'utf8')).version, 1);
});

test('large run output is not duplicated inside metadata when an artifact holds it', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-store-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const store = new SubagentStore({ agentDir, ownerSessionId: 'session-1' });
  const agentId = '123e4567-e89b-12d3-a456-426614174000';
  const output = 'PRIVATE_SENTINEL'.repeat(10_000);
  await store.saveResult(agentId, 'run-1', output);
  await store.saveAgent({
    agentId,
    ownerSessionId: 'session-1',
    runs: [{ runId: 'run-1', state: 'completed', result: output, resultStored: true }],
  });
  const metadata = await readFile(join(store.agentPath(agentId), 'metadata.json'), 'utf8');
  assert.equal(metadata.includes('PRIVATE_SENTINEL'), false);
  assert.equal((await store.loadAgent(agentId)).runs[0].resultStored, true);
});

test('line-bounded pages always advance past their delimiter', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-store-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const store = new SubagentStore({ agentDir, ownerSessionId: 'session-1' });
  const agentId = '123e4567-e89b-12d3-a456-426614174000';
  await store.saveResult(agentId, 'run-1', 'first\nsecond\n');
  const first = await store.readResult(agentId, 'run-1', { maxBytes: 100, maxLines: 1 });
  assert.equal(first.text, 'first\n');
  const second = await store.readResult(agentId, 'run-1', { cursor: first.nextCursor, maxBytes: 100, maxLines: 1 });
  assert.equal(second.text, 'second\n');
});

test('a byte limit smaller than the next Unicode character fails rather than returning the same cursor', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-store-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const store = new SubagentStore({ agentDir, ownerSessionId: 'session-1' });
  const agentId = '123e4567-e89b-12d3-a456-426614174000';
  await store.saveResult(agentId, 'run-1', '😀x');
  await assert.rejects(store.readResult(agentId, 'run-1', { maxBytes: 1 }), /maxBytes|character|Unicode/i);
  const first = await store.readResult(agentId, 'run-1', { maxBytes: 4 });
  assert.equal(first.text, '😀');
  assert.equal(first.nextCursor, 4);
  const second = await store.readResult(agentId, 'run-1', { maxBytes: 1, cursor: first.nextCursor });
  assert.equal(second.text, 'x');
  assert.equal(second.nextCursor, undefined);
});

test('reads a live child transcript by bounded cursor and rejects an external transcript path', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-transcript-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const store = new SubagentStore({ agentDir, ownerSessionId: 'session-1' });
  const agentId = '123e4567-e89b-12d3-a456-426614174000';
  const directory = await store.ensureAgentDirectory(agentId);
  const sessionFile = join(directory, 'child.jsonl');
  await writeFile(sessionFile, '{"type":"message","text":"é"}\n');
  const first = await store.readTranscript(agentId, { maxBytes: 17 });
  assert.equal(first.text, '{"type":"message"');
  await writeFile(sessionFile, '{"type":"message","text":"é"}\n{"type":"message","text":"new"}\n');
  const second = await store.readTranscript(agentId, { cursor: first.nextCursor, maxBytes: 100 });
  assert.match(second.text, /new/);
  const outside = join(agentDir, 'outside.jsonl');
  await writeFile(outside, 'secret');
  await assert.rejects(store.readTranscript(agentId, { sessionFile: outside }), /outside|private|transcript/i);
  await symlink(outside, join(directory, 'linked.jsonl'));
  await assert.rejects(
    store.readTranscript(agentId, { sessionFile: join(directory, 'linked.jsonl') }),
    /outside|private|transcript/i,
  );
});

test('restores intact archives even when another metadata file is damaged, reporting its identifier', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-store-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const store = new SubagentStore({ agentDir, ownerSessionId: 'session-1' });
  const goodId = '123e4567-e89b-42d3-a456-426614174000';
  const badId = '223e4567-e89b-42d3-a456-426614174000';
  await store.saveAgent({ agentId: goodId, ownerSessionId: 'session-1', runs: [] });
  const badDirectory = await store.ensureAgentDirectory(badId);
  await writeFile(join(badDirectory, 'metadata.json'), 'damaged-json');
  const errors = [];
  const agents = await store.loadAgents({ onError: (agentId, error) => errors.push({ agentId, error }) });
  assert.deepEqual(
    agents.map(agent => agent.agentId),
    [goodId],
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].agentId, badId);
  assert.match(errors[0].error.message, /metadata/i);
});

test('rejects traversal, malformed identifiers and unknown metadata versions', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-store-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const store = new SubagentStore({ agentDir, ownerSessionId: 'safe' });
  await assert.rejects(store.saveResult('../escape', 'run', 'x'), /identifier/i);
  await assert.rejects(store.readResult('123e4567-e89b-12d3-a456-426614174000', '../run'), /identifier/i);
});
