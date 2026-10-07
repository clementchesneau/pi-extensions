import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { createSubagentTools } from '../packages/subagents/tools.js';
import { availableModelGuide, loadModelGuide, syncModelGuide } from '../packages/subagents/model-guide.js';

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
  sources: ['https://example.org/model'],
  reviewedOn: '2026-09-27',
});
async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'subagent-model-guide-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function setup(t, profiles) {
  const root = await temporaryRoot(t);
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

test('bundled editable guide covers all approved sourced models', async t => {
  const guide = await loadModelGuide();
  assert.equal(guide.length, 12);
  assert.ok(
    guide.every(entry => entry.sources?.length > 0 && entry.reviewedOn && entry.status === undefined),
    'bundled entries cite source documents and a review date',
  );
  const path = join(await temporaryRoot(t), 'subagent-models.json');
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
  const chosen = await availableModelGuide(
    {
      model: model('openai-codex', 'gpt-6-sol'),
      modelRegistry: { getAvailable: () => [model('openai-codex', 'gpt-6-sol')] },
      scopedModels: [],
    },
    { path },
  );
  assert.equal(chosen.total, 1);
  assert.equal(chosen.items[0].modelId, 'gpt-6-sol');
  const newSol = await availableModelGuide(
    {
      model: model('openai-codex', 'gpt-6.1-sol'),
      modelRegistry: { getAvailable: () => [model('openai-codex', 'gpt-6.1-sol')] },
    },
    { path },
  );
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
  assert.equal(result.items[0].reviewedOn, '2026-09-27');
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

test('first consultation generates an editable copy that follows bundled updates until it is edited', async t => {
  const root = await temporaryRoot(t);
  const bundled = join(root, 'bundled.json');
  const path = join(root, 'config', 'subagent-models.json');
  const saveBundled = preferFor =>
    writeFile(bundled, JSON.stringify({ version: 1, models: [profile('a', 'm', preferFor)] }));
  const readCopy = async () => JSON.parse(await readFile(path, 'utf8'));
  await saveBundled('Bundled v1');
  const tool = createSubagentTools({
    getManager: () => ({}),
    modelGuidePath: path,
    bundledModelGuidePath: bundled,
  }).find(value => value.name === 'subagent_models');
  const ctx = { modelRegistry: { getAvailable: () => [model('a', 'm')] } };
  const preferFor = async () => (await call(tool, ctx)).items[0].preferFor;

  assert.equal(await preferFor(), 'Bundled v1');
  const generated = await readCopy();
  assert.deepEqual(generated.models, [profile('a', 'm', 'Bundled v1')]);
  assert.match(generated.generated.sha256, /^[0-9a-f]{64}$/u);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  // Reformatting keeps the copy managed: only its content counts as an edit.
  const [entry] = generated.models;
  const reordered = Object.fromEntries(Object.entries(entry).reverse());
  await writeFile(path, JSON.stringify({ models: [reordered], generated: generated.generated, version: 1 }));
  await saveBundled('Bundled v2');
  assert.equal(await preferFor(), 'Bundled v2');
  assert.equal((await readCopy()).models[0].preferFor, 'Bundled v2');

  const edited = await readCopy();
  edited.models[0].preferFor = 'Mine';
  await writeFile(path, JSON.stringify(edited, null, 2));
  const own = await call(tool, ctx);
  assert.equal(own.items[0].preferFor, 'Mine');
  assert.equal(own.catalogueUpdate, undefined);

  await saveBundled('Bundled v3');
  const kept = await call(tool, ctx);
  assert.equal(kept.items[0].preferFor, 'Mine');
  assert.match(kept.catalogueUpdate, /delete/i);
  assert.equal((await readCopy()).models[0].preferFor, 'Mine');

  await rm(path);
  assert.equal(await preferFor(), 'Bundled v3');
});

test('personal entries need no sources or review date, and legacy status is ignored', async t => {
  const personal = { provider: 'a', id: 'm', preferFor: 'Lecture', avoidFor: 'Refonte', tradeoff: 'Local' };
  const { tool, save } = await setup(t, [personal]);
  const ctx = { modelRegistry: { getAvailable: () => [model('a', 'm')] } };
  const [item] = (await call(tool, ctx)).items;
  assert.equal(item.preferFor, 'Lecture');
  assert.equal(item.sources, undefined);
  assert.equal(item.reviewedOn, undefined);

  await save([{ ...profile('a', 'm'), status: 'verified' }]);
  assert.equal((await call(tool, ctx)).items[0].status, undefined);

  await save([{ ...personal, sources: ['http://insecure.example'] }]);
  await assert.rejects(call(tool, ctx), /catalogue entry a\/m/);
  await save([{ ...personal, reviewedOn: 'yesterday' }]);
  await assert.rejects(call(tool, ctx), /catalogue entry a\/m/);
});

test('a copy edited while its update is being decided is kept', async t => {
  const root = await temporaryRoot(t);
  const path = join(root, 'subagent-models.json');
  const bundled = join(root, 'bundled.json');
  const guide = preferFor => JSON.stringify({ version: 1, models: [profile('a', 'm', preferFor)] });
  await writeFile(bundled, guide('Bundled v1'));
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => syncModelGuide({ path, bundledPath: bundled })));
  assert.ok(concurrent.every(result => result.models[0].preferFor === 'Bundled v1'));

  // The update reads the copy, then the bundled catalogue: a FIFO holds it between the two.
  const fifo = join(root, 'bundled.fifo');
  execFileSync('mkfifo', [fifo]);
  const update = syncModelGuide({ path, bundledPath: fifo });
  const bundledWriter = await open(fifo, 'w');
  const edited = JSON.parse(await readFile(path, 'utf8'));
  edited.models[0].preferFor = 'Mine';
  await writeFile(path, JSON.stringify(edited));
  await bundledWriter.writeFile(guide('Bundled v2'));
  await bundledWriter.close();

  const result = await update;
  assert.equal(result.models[0].preferFor, 'Mine');
  assert.match(result.catalogueUpdate, /delete/i);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).models[0].preferFor, 'Mine');
});

test('a bundled catalogue too large to copy fails before writing an unreadable copy', async t => {
  const root = await temporaryRoot(t);
  const path = join(root, 'subagent-models.json');
  const bundled = join(root, 'bundled.json');
  const long = 'x'.repeat(120);
  const models = Array.from({ length: 200 }, (_, index) => ({
    ...profile('a', `m${index}`, long),
    avoidFor: long,
    tradeoff: long,
  }));
  const compact = JSON.stringify({ version: 1, models });
  assert.ok(Buffer.byteLength(compact) <= 128 * 1024, 'the bundled catalogue itself is readable');
  assert.ok(Buffer.byteLength(JSON.stringify({ models }, null, 2)) > 128 * 1024, 'its indented copy is not');
  await writeFile(bundled, compact);
  await assert.rejects(syncModelGuide({ path, bundledPath: bundled }), /exceed 128 KiB/);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});
