import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../packages/session-compaction/store.js';

const execute = promisify(execFile);
const storeModule = new URL('../packages/session-compaction/store.js', import.meta.url).href;

for (const target of ['revision', 'owner']) {
  test(
    `a FIFO ${target} is refused without blocking ${target === 'owner' ? 'startup collection' : 'memory reading'}`,
    { timeout: 5000 },
    async t => {
      const parent = await mkdtemp(join(tmpdir(), 'compaction-fifo-test-'));
      t.after(() => rm(parent, { recursive: true, force: true }));
      // A child with a hard timeout isolates the pre-fix blocking open syscall.
      const script = `
      import assert from 'node:assert/strict';
      import { rm, lstat } from 'node:fs/promises';
      import { execFileSync } from 'node:child_process';
      import { join } from 'node:path';
      import { MemoryStore, collectOrphans } from ${JSON.stringify(storeModule)};
      const store = await MemoryStore.create({ parent: ${JSON.stringify(parent)} });
      const note = await store.write({ id: 'facts', title: 'Facts', content: 'VERIFIED' });
      const path = join(store.directory, ${JSON.stringify(target === 'owner' ? 'owner.json' : '')} || note.revision + '.json');
      await rm(path);
      execFileSync('mkfifo', ['-m', '600', path]);
      ${
        target === 'owner'
          ? `assert.deepEqual(await collectOrphans({ parent: ${JSON.stringify(parent)} }), { removed: 0, retained: 1 });`
          : `await assert.rejects(store.read(note), /Unsafe memory file/);`
      }
      assert.ok((await lstat(path)).isFIFO(), 'unsafe file must not be deleted');
      console.log('FIFO_REFUSED');
    `;
      const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], {
        timeout: 2000,
        killSignal: 'SIGKILL',
        maxBuffer: 65536,
      });
      assert.match(stdout, /FIFO_REFUSED/);
    },
  );
}

test('temporary parents are excluded by path components, including dot-dot-prefixed child names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compaction-boundary-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  for (const name of ['cache', '..cache', '..']) {
    const parent = join(workspace, name);
    if (name !== '..') await mkdir(parent);
    if (name === '..') {
      const store = await MemoryStore.create({ parent, cwd: workspace });
      await store.close();
    } else {
      await assert.rejects(MemoryStore.create({ parent, cwd: workspace }), /outside the workspace/);
      assert.deepEqual(await readdir(parent), [], 'rejection must not create a store');
    }
  }
  await assert.rejects(MemoryStore.create({ parent: workspace, cwd: workspace }), /outside the workspace/);
  const alias = join(root, 'alias');
  await symlink(join(workspace, '..cache'), alias);
  await assert.rejects(MemoryStore.create({ parent: alias, cwd: workspace }), /outside the workspace/);
  const sibling = join(root, '..outside');
  await mkdir(sibling);
  const store = await MemoryStore.create({ parent: sibling, cwd: workspace });
  await store.close();
});
