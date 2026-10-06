import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitCoordinator, parseGitStatus, readGitSnapshot } from '../packages/graphite-ui/git.js';

const exec = promisify(execFile);

async function git(cwd, ...args) {
  return exec('git', args, { cwd });
}

async function makeRepo({ commit = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'graphite-git-'));
  await git(cwd, 'init', '-q', '-b', 'main');
  await git(cwd, 'config', 'user.email', 'graphite@example.test');
  await git(cwd, 'config', 'user.name', 'Graphite Test');
  if (commit) {
    await writeFile(join(cwd, 'tracked.txt'), 'base\n');
    await git(cwd, 'add', 'tracked.txt');
    await git(cwd, 'commit', '-qm', 'base');
  }
  return cwd;
}

test('parses porcelain v2 NUL records without double-counting renames or unusual paths', () => {
  const fixture = [
    '# branch.oid 0123456789abcdef',
    '# branch.head (detached)',
    '1 .M N... 100644 100644 100644 aaa aaa file with space',
    '2 R. N... 100644 100644 100644 aaa bbb R100 renamed\nfile',
    'source name',
    '? e\u0301-資料',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict',
    '',
  ].join('\0');
  assert.deepEqual(parseGitStatus(fixture), {
    state: 'valid',
    branch: 'detached@0123456',
    changedFiles: 4,
  });
});

test('reads coherent snapshots from isolated repositories', async t => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  assert.deepEqual(await readGitSnapshot(cwd), {
    state: 'valid',
    branch: 'main',
    changedFiles: 0,
  });

  await writeFile(join(cwd, 'tracked.txt'), 'staged\n');
  await git(cwd, 'add', 'tracked.txt');
  await writeFile(join(cwd, 'tracked.txt'), 'unstaged too\n');
  await writeFile(join(cwd, 'untracked\nname.txt'), 'new');
  await writeFile(join(cwd, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(cwd, 'ignored.txt'), 'ignored');
  assert.equal((await readGitSnapshot(cwd)).changedFiles, 3);

  await git(cwd, 'add', '-A');
  await git(cwd, 'commit', '-qm', 'changes');
  await git(cwd, 'mv', 'tracked.txt', 'renamed.txt');
  await mkdir(join(cwd, 'nested'));
  assert.equal((await readGitSnapshot(join(cwd, 'nested'))).changedFiles, 1);

  await git(cwd, 'commit', '-am', 'rename', '-q');
  await git(cwd, 'checkout', '-q', '--detach');
  assert.match((await readGitSnapshot(cwd)).branch, /^detached@[0-9a-f]{7}$/);
});

test('handles unborn branches, conflicts, outside repositories and runner failures', async t => {
  const unborn = await makeRepo({ commit: false });
  const outside = await mkdtemp(join(tmpdir(), 'graphite-outside-'));
  t.after(() =>
    Promise.all([rm(unborn, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]),
  );
  const unbornSnapshot = await readGitSnapshot(unborn);
  assert.equal(unbornSnapshot.state, 'valid');
  assert.equal(unbornSnapshot.branch, 'main');
  assert.equal(unbornSnapshot.changedFiles, 0);
  assert.deepEqual(await readGitSnapshot(outside), {
    state: 'outside',
    branch: null,
    changedFiles: null,
  });

  const missing = await readGitSnapshot(unborn, {
    runner: async () => {
      const error = new Error('spawn git ENOENT');
      error.code = 'ENOENT';
      throw error;
    },
  });
  assert.equal(missing.state, 'unknown');
  assert.equal(missing.changedFiles, null);
  assert.match(missing.error, /ENOENT/);

  const oversized = await readGitSnapshot(unborn, {
    runner: async () => {
      const error = new Error('stdout maxBuffer length exceeded');
      error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      throw error;
    },
  });
  assert.equal(oversized.state, 'unknown');
  assert.equal(oversized.changedFiles, null);

  const timedOut = await readGitSnapshot(unborn, {
    runner: async () => {
      const error = new Error('Git timed out');
      error.code = 'ETIMEDOUT';
      throw error;
    },
  });
  assert.equal(timedOut.state, 'unknown');
  assert.equal(timedOut.changedFiles, null);
});

test('counts a conflicted path once', async t => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, 'checkout', '-qb', 'other');
  await writeFile(join(cwd, 'tracked.txt'), 'other\n');
  await git(cwd, 'commit', '-am', 'other', '-q');
  await git(cwd, 'checkout', '-q', 'main');
  await writeFile(join(cwd, 'tracked.txt'), 'main\n');
  await git(cwd, 'commit', '-am', 'main', '-q');
  await assert.rejects(git(cwd, 'merge', 'other'));
  assert.equal((await readGitSnapshot(cwd)).changedFiles, 1);
});

test('coalesces refreshes and suppresses stale snapshots after cancellation', async () => {
  const pending = [];
  const published = [];
  const reader = (_cwd, { signal }) =>
    new Promise((resolve, reject) => {
      pending.push({ resolve, reject, signal });
    });
  const coordinator = createGitCoordinator({
    cwd: '/tmp/repo',
    reader,
    onSnapshot: snapshot => published.push(snapshot),
  });

  const first = coordinator.refresh();
  coordinator.refresh();
  coordinator.refresh();
  assert.equal(pending.length, 1);
  pending[0].resolve({ state: 'valid', branch: 'main', changedFiles: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[1].resolve({ state: 'valid', branch: 'main', changedFiles: 2 });
  await first;
  assert.equal(published.at(-1).changedFiles, 2);
  assert.equal(pending.length, 2);

  const stale = coordinator.refresh();
  assert.equal(pending.length, 3);
  coordinator.cancel();
  assert.equal(pending[2].signal.aborted, true);
  pending[2].resolve({ state: 'valid', branch: 'stale', changedFiles: 99 });
  await stale;
  assert.notEqual(published.at(-1)?.branch, 'stale');
});
