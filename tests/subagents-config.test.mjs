import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  loadSubagentConfig,
  saveSubagentConfig,
  updateSubagentConfig,
  writePrivateFile,
} from '../packages/subagents/config.js';

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

test('conditional replacement writes only over the expected content and never over a newer save', async t => {
  const path = await fixture(t);
  const files = async () => (await readdir(join(path, '..'))).sort();

  assert.equal(await writePrivateFile(path, 'v1', 'copy', { expected: null }), true);
  assert.equal(await writePrivateFile(path, 'v2', 'copy', { expected: null }), false, 'an existing file is kept');
  assert.equal(await writePrivateFile(path, 'v2', 'copy', { expected: Buffer.from('v1') }), true);
  assert.equal(await readFile(path, 'utf8'), 'v2');
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  await writeFile(path, 'Mine');
  assert.equal(await writePrivateFile(path, 'v3', 'copy', { expected: Buffer.from('v2') }), false);
  assert.equal(await readFile(path, 'utf8'), 'Mine', 'a save made before the replacement is restored');
  await rm(path);
  assert.equal(await writePrivateFile(path, 'v3', 'copy', { expected: Buffer.from('v2') }), false);
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.deepEqual(await files(), []);
});

test('a save made while the replaced content is being compared is kept', async t => {
  const path = await fixture(t);
  // A FIFO holds the comparison open: the replaced file is read only when the test writes it.
  execFileSync('mkfifo', [path]);
  const replacedContent = open(path, 'w');
  const replacement = writePrivateFile(path, 'v2', 'copy', { expected: Buffer.from('v1') });
  const writer = await replacedContent;
  await writeFile(path, 'Mine');
  await writer.writeFile('v1');
  await writer.close();
  assert.equal(await replacement, false);
  assert.equal(await readFile(path, 'utf8'), 'Mine');
  assert.deepEqual(await readdir(join(path, '..')), ['subagents.json']);
});
