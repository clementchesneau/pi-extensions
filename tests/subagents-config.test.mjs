import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadSubagentConfig, saveSubagentConfig, updateSubagentConfig } from '../packages/subagents/config.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'subagent-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'subagents.json');
}

test('creates only a missing global configuration with the approved defaults', async t => {
  const path = await fixture(t);
  assert.deepEqual(await loadSubagentConfig({ path }), { version: 1, autoDelegate: true, maxConcurrent: 4 });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, autoDelegate: true, maxConcurrent: 4 });
});

test('rejects malformed, unknown or unsafe configuration without re-enabling delegation', async t => {
  const path = await fixture(t);
  for (const content of [
    '{bad json',
    JSON.stringify({ version: 1, autoDelegate: false, maxConcurrent: 4, unexpected: true }),
    JSON.stringify({ version: 1, autoDelegate: 'false', maxConcurrent: 4 }),
    JSON.stringify({ version: 1, autoDelegate: false, maxConcurrent: 0 }),
  ]) {
    await writeFile(path, content, { mode: 0o600 });
    await assert.rejects(loadSubagentConfig({ path }), /configuration/i);
  }
});

test('concurrent changes to different fields compose under the same configuration lock', async t => {
  const path = await fixture(t);
  await loadSubagentConfig({ path });
  await Promise.all([
    updateSubagentConfig({ autoDelegate: false }, { path }),
    updateSubagentConfig({ maxConcurrent: 2 }, { path }),
  ]);
  assert.deepEqual(await loadSubagentConfig({ path }), { version: 1, autoDelegate: false, maxConcurrent: 2 });
  await assert.rejects(
    updateSubagentConfig(
      { maxConcurrent: 1 },
      {
        path,
        validate: config => {
          if (config.maxConcurrent < 2) throw new Error('two active runs');
        },
      },
    ),
    /two active runs/,
  );
  assert.equal((await loadSubagentConfig({ path })).maxConcurrent, 2);
});

test('persists an explicit valid update atomically and leaves prior settings after a rejected update', async t => {
  const path = await fixture(t);
  await loadSubagentConfig({ path });
  const saved = await saveSubagentConfig({ version: 1, autoDelegate: false, maxConcurrent: 2 }, { path });
  assert.deepEqual(saved, { version: 1, autoDelegate: false, maxConcurrent: 2 });
  await assert.rejects(
    saveSubagentConfig({ version: 1, autoDelegate: false, maxConcurrent: -1 }, { path }),
    /configuration/i,
  );
  assert.deepEqual(await loadSubagentConfig({ path }), saved);
  await access(path);
});
