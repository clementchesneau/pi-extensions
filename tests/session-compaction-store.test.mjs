import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, lstat, symlink, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../packages/session-compaction/store.js';

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'compaction-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const store = await MemoryStore.create({ parent, cwd: process.cwd() });
  return { parent, store };
}

test('private temporary store atomically retains immutable revisions and removes owned files', async t => {
  const { store } = await fixture(t);
  assert.equal((await lstat(store.directory)).mode & 0o777, 0o700);
  const first = await store.write({ id: 'facts', title: 'Verified facts', content: 'first version' });
  const second = await store.write({ id: 'facts', title: 'New facts', content: 'second version' });
  assert.notEqual(first.revision, second.revision);
  assert.equal((await store.read(first)).content, 'first version');
  assert.equal((await store.read(second)).content, 'second version');
  assert.deepEqual(
    (await readdir(store.directory)).sort(),
    ['owner.json', ...[first.revision, second.revision].map(id => `${id}.json`)].sort(),
  );
  for (const file of await readdir(store.directory))
    assert.equal((await lstat(join(store.directory, file))).mode & 0o777, 0o600);
  await store.close();
  await assert.rejects(lstat(store.directory), { code: 'ENOENT' });
  await store.close();
});

test('store refuses paths, oversized notes and symlink escapes without touching targets', async t => {
  const { parent, store } = await fixture(t);
  for (const id of ['../outside', '/tmp/data', 'UPPER', '']) {
    await assert.rejects(store.write({ id, title: 'Title', content: 'facts' }), /id/);
  }
  await assert.rejects(store.write({ id: 'facts', title: 'Title', content: 'é'.repeat(17000) }), /content/);
  await assert.rejects(store.write({ id: 'facts', title: 'bad\nheading', content: 'facts' }), /title/);
  const note = await store.write({ id: 'facts', title: 'Title', content: 'facts' });
  const target = join(parent, 'outside');
  await writeFile(target, 'KEEP');
  await rm(join(store.directory, `${note.revision}.json`));
  await symlink(target, join(store.directory, `${note.revision}.json`));
  await assert.rejects(store.read(note));
  await assert.rejects(store.close(), /unsafe/);
  assert.equal(await readFile(target, 'utf8'), 'KEEP');
  await assert.rejects(store.read({ ...note, revision: '../outside' }), /revision/);
});

test('replacement of the private root and unknown files stop writes and cleanup', async t => {
  const { parent, store } = await fixture(t);
  const note = await store.write({ id: 'facts', title: 'Facts', content: 'PRESERVE' });
  await writeFile(join(store.directory, 'unowned'), 'KEEP');
  await assert.rejects(store.close(), /unowned/);
  assert.equal((await store.read(note)).content, 'PRESERVE');
  const moved = `${store.directory}-moved`;
  await rename(store.directory, moved);
  await symlink(parent, store.directory);
  await assert.rejects(store.write({ id: 'facts', title: 'Title', content: 'facts' }), /Unsafe/);
  await assert.rejects(store.close(), /Unsafe/);
  assert.equal(await readFile(join(moved, 'unowned'), 'utf8'), 'KEEP');
});
