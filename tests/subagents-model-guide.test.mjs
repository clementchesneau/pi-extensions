import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { createSubagentTools } from '../packages/subagents/tools.js';
import { availableModelGuide, loadModelGuide } from '../packages/subagents/model-guide.js';

const model = (provider, id, overrides = {}) => ({
  provider,
  id,
  name: id,
  reasoning: true,
  input: ['text'],
  contextWindow: 200_000,
  cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  ...overrides,
});
const profile = (provider, id, preferFor = 'Tâches ciblées') => ({
  provider,
  id,
  preferFor,
  avoidFor: 'Diagnostics complexes',
  tradeoff: 'Répétitions à coût modéré',
  effort: { simple: 'low', standard: 'medium', complex: 'high' },
  status: 'verified',
  sources: ['https://example.org/model'],
  reviewedOn: '2026-09-27',
});
async function setup(t, profiles) {
  const root = await mkdtemp(join(tmpdir(), 'subagent-model-guide-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'guide.json');
  const save = async models => writeFile(path, JSON.stringify({ version: 1, models }));
  await save(profiles);
  const tool = createSubagentTools({ getManager: () => ({}), modelGuidePath: path }).find(
    value => value.name === 'subagent_models',
  );
  return { tool, save, path };
}
const call = async (tool, ctx, params = {}) =>
  JSON.parse((await tool.execute('call', params, undefined, undefined, ctx)).content[0].text);

test('bundled editable guide covers all approved sourced models', async () => {
  const guide = await loadModelGuide();
  assert.equal(guide.length, 12);
  assert.ok(
    guide.every(entry => entry.status === 'verified'),
    'entries have source documents, not independent quality benchmarks',
  );
  for (const id of [
    'gpt-6-luna',
    'gpt-6.1-sol',
    'gpt-6-sol',
    'gpt-6-astra',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'claude-sonnet-5',
    'claude-opus-5-5',
    'gemini-3.8-flash',
    'deepseek-flash',
  ]) {
    assert.ok(
      guide.some(entry => entry.id === id),
      `missing ${id}`,
    );
  }
  const chosen = await availableModelGuide({
    model: model('openai-codex', 'gpt-6-sol'),
    modelRegistry: { getAvailable: () => [model('openai-codex', 'gpt-6-sol')] },
    scopedModels: [],
  });
  assert.equal(chosen.total, 1);
  assert.equal(chosen.items[0].modelId, 'gpt-6-sol');
  const newSol = await availableModelGuide({
    model: model('openai-codex', 'gpt-6.1-sol'),
    modelRegistry: { getAvailable: () => [model('openai-codex', 'gpt-6.1-sol')] },
  });
  assert.equal(newSol.total, 1);
  assert.equal(newSol.items[0].modelId, 'gpt-6.1-sol');
  assert.equal(newSol.items[0].effort.complex, 'high');
});

test('consultation shows all available exact matches regardless of rotation, with live Pi capabilities', async t => {
  const { tool } = await setup(t, [
    profile('openai-codex', 'gpt-6-sol'),
    profile('anthropic', 'claude-sonnet-5'),
    profile('google', 'gemini-3.8-flash'),
  ]);
  const available = [
    model('openai-codex', 'gpt-6-sol', { cost: { input: 42, output: 43 }, contextWindow: 5000 }),
    model('anthropic', 'claude-sonnet-5'),
    model('openai-codex', 'unlisted'),
  ];
  const ctx = {
    model: available[0],
    thinkingLevel: 'medium',
    modelRegistry: { getAvailable: () => available },
    scopedModels: [{ model: available[0] }],
  };
  const result = await call(tool, ctx);
  assert.equal(result.current.provider, 'openai-codex');
  assert.equal(result.current.modelId, 'gpt-6-sol');
  assert.equal(result.current.thinkingLevel, 'medium');
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.items.map(item => item.modelId),
    ['gpt-6-sol', 'claude-sonnet-5'],
  );
  assert.equal(result.items[0].cost.input, 42);
  assert.equal(result.items[0].contextWindow, 5000);
  assert.equal(result.items[0].preferFor, 'Tâches ciblées');
  assert.equal(result.items[0].status, 'verified');
  assert.equal(result.items[0].sources[0], 'https://example.org/model');
  assert.doesNotMatch(JSON.stringify(result), /unlisted|gemini-3.8-flash/);
});

test('catalogue is reloaded on each call, paginated, and never promises unavailable models', async t => {
  const { tool, save } = await setup(t, [profile('a', 'first'), profile('a', 'second'), profile('a', 'missing')]);
  const available = [model('a', 'first'), model('a', 'second')];
  const ctx = { model: available[0], modelRegistry: { getAvailable: () => available }, scopedModels: [] };
  assert.equal(Check(tool.parameters, { cursor: 0, limit: 1 }), true);
  assert.equal(Check(tool.parameters, { cursor: -1 }), false);
  const first = await call(tool, ctx, { limit: 1 });
  assert.deepEqual(
    first.items.map(item => item.modelId),
    ['first'],
  );
  assert.equal(first.nextCursor, 1);
  const second = await call(tool, ctx, { cursor: first.nextCursor, limit: 1 });
  assert.deepEqual(
    second.items.map(item => item.modelId),
    ['second'],
  );
  assert.equal(second.nextCursor, undefined);
  await save([profile('a', 'second', 'Modified locally')]);
  assert.equal((await call(tool, ctx)).items[0].preferFor, 'Modified locally');
  await save([profile('a', 'missing')]);
  assert.deepEqual((await call(tool, ctx)).items, []);
});

test('invalid catalogue fails explicitly instead of silently inheriting or picking a model', async t => {
  const { tool, path } = await setup(t, []);
  await writeFile(path, JSON.stringify({ version: 1, models: [profile('a', 'x'), profile('a', 'x')] }));
  await assert.rejects(
    call(tool, { modelRegistry: { getAvailable: () => [] }, scopedModels: [] }),
    /duplicate|doublon/i,
  );
  await writeFile(path, '{bad');
  await assert.rejects(
    call(tool, { modelRegistry: { getAvailable: () => [] }, scopedModels: [] }),
    /catalogue|guide|JSON/i,
  );
});
