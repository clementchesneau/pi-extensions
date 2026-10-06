import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { MemoryStore, collectOrphans } from '../packages/session-compaction/store.js';

async function setup(t) {
  const parent = await mkdtemp(join(tmpdir(), 'compaction-orphan-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const store = await MemoryStore.create({ parent, cwd: process.cwd() });
  await store.write({ id: 'facts', title: 'Facts', content: 'DATA' });
  return { parent, store };
}

async function makeDead(parent, store) {
  const markerPath = join(store.directory, 'owner.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  marker.pid = 2147483647; // Outside realistic OS pid range; kill(pid, 0) reports ESRCH.
  await writeFile(markerPath, JSON.stringify(marker));
  const dead = join(parent, basename(store.directory).replace(`-${process.pid}-`, `-${marker.pid}-`));
  await rename(store.directory, dead);
  return dead;
}

test('orphan collection preserves live owners and removes only marked private dead-owner stores', async t => {
  const { parent, store } = await setup(t);
  await collectOrphans({ parent });
  assert.equal((await readdir(parent)).length, 1);
  await makeDead(parent, store);
  const report = await collectOrphans({ parent });
  assert.equal(report.removed, 1);
  assert.deepEqual(await readdir(parent), []);
});

test('unknown files and symlinks make orphan directories ineligible for deletion', async t => {
  for (const symlinked of [false, true]) {
    const { parent, store } = await setup(t);
    const dead = await makeDead(parent, store);
    const target = join(parent, 'outside');
    await writeFile(target, 'KEEP');
    if (symlinked) {
      const blob = (await readdir(dead)).find(name => name.endsWith('.json') && name !== 'owner.json');
      await rm(join(dead, blob));
      await symlink(target, join(dead, blob));
    } else await writeFile(join(dead, 'unknown'), 'KEEP');
    assert.equal((await collectOrphans({ parent })).removed, 0);
    assert.equal(await readFile(target, 'utf8'), 'KEEP');
    assert.ok((await readdir(parent)).some(name => name.startsWith('pi-session-compaction-')));
  }
});
