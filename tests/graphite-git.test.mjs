import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
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

/** An executable that leaves `marker` behind when git runs it, then passes its input through. */
async function trap(directory, marker) {
  const path = join(directory, 'trap.sh');
  await writeFile(path, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  return path;
}

const exists = path =>
  stat(path).then(
    () => true,
    () => false,
  );

test('a repository whose own config runs commands shows its branch without running git status', async t => {
  const outside = await mkdtemp(join(tmpdir(), 'graphite-trap-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const marker = join(outside, 'ran');
  const command = await trap(outside, marker);
  const filter = async (cwd, setting, value) => {
    await writeFile(join(cwd, '.git', 'filters'), `[filter "x"]\n\t${setting} = ${JSON.stringify(value)}\n`);
    await git(cwd, 'config', 'include.path', 'filters');
    await writeFile(join(cwd, '.gitattributes'), '* filter=x\n');
  };
  const attacks = {
    'fsmonitor hook': cwd => git(cwd, 'config', 'core.fsmonitor', command),
    'fsmonitor hook after a boolean line': cwd => git(cwd, 'config', 'core.fsmonitor', `true\n${command}`),
    'fsmonitor hook after an empty line': cwd => git(cwd, 'config', 'core.fsmonitor', `\n${command}`),
    'included clean filter': cwd => filter(cwd, 'clean', command),
    'clean filter after an empty line': cwd => filter(cwd, 'clean', `\n${command}`),
    'process filter after an empty line': cwd => filter(cwd, 'process', `\n${command}`),
  };
  for (const [attack, configure] of Object.entries(attacks)) {
    const cwd = await makeRepo();
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await configure(cwd);
    // Same size, newer time: git must read the file again, through any filter.
    const tracked = join(cwd, 'tracked.txt');
    await writeFile(tracked, 'BASE\n');
    const later = new Date(Date.now() + 10_000);
    await utimes(tracked, later, later);
    assert.deepEqual(await readGitSnapshot(cwd), { state: 'valid', branch: 'main', changedFiles: null }, attack);
    assert.equal(await exists(marker), false, `${attack} ran`);
  }
  const detached = await makeRepo();
  t.after(() => rm(detached, { recursive: true, force: true }));
  await git(detached, 'checkout', '-q', '--detach');
  await attacks['fsmonitor hook'](detached);
  assert.match((await readGitSnapshot(detached)).branch, /^detached@[0-9a-f]{7}$/);
  assert.equal(await exists(marker), false);
});

test('user-level filters and fsmonitor settings keep the changed-file count', async t => {
  const cwd = await makeRepo();
  const outside = await mkdtemp(join(tmpdir(), 'graphite-global-'));
  t.after(() =>
    Promise.all([rm(cwd, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]),
  );
  const globalConfig = join(outside, 'gitconfig');
  await writeFile(globalConfig, '[core]\n\tfsmonitor = false\n[filter "lfs"]\n\tclean = git-lfs clean -- %f\n');
  await git(cwd, 'config', 'core.fsmonitor', 'false');
  await writeFile(join(cwd, 'tracked.txt'), 'changed\n');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  try {
    assert.deepEqual(await readGitSnapshot(cwd), { state: 'valid', branch: 'main', changedFiles: 1 });
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
});

test('git status does not run commands configured inside a submodule', async t => {
  const cwd = await makeRepo();
  const library = await makeRepo();
  const outside = await mkdtemp(join(tmpdir(), 'graphite-submodule-'));
  t.after(() => Promise.all([cwd, library, outside].map(directory => rm(directory, { recursive: true, force: true }))));
  const marker = join(outside, 'ran');
  const command = await trap(outside, marker);
  await git(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'library');
  await git(cwd, 'commit', '-qm', 'submodule');
  await git(join(cwd, 'library'), 'config', 'core.fsmonitor', command);
  await writeFile(join(cwd, 'library', 'tracked.txt'), 'changed\n');
  await writeFile(join(cwd, 'tracked.txt'), 'changed\n');
  assert.deepEqual(await readGitSnapshot(cwd), { state: 'valid', branch: 'main', changedFiles: 1 });
  assert.equal(await exists(marker), false, 'the submodule fsmonitor hook ran');
});

const gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' })
  .match(/(\d+)\.(\d+)/)
  .slice(1)
  .map(Number);

test(
  'git status never fetches a partial clone object through a transport the repository configures',
  // GIT_NO_LAZY_FETCH exists since Git 2.45.
  { skip: gitVersion[0] < 2 || (gitVersion[0] === 2 && gitVersion[1] < 45) },
  async t => {
    const cwd = await makeRepo();
    const outside = await mkdtemp(join(tmpdir(), 'graphite-lazy-fetch-'));
    t.after(() =>
      Promise.all([rm(cwd, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]),
    );
    const marker = join(outside, 'ran');
    const command = await trap(outside, marker);
    // A staged, edited rename makes git status read the HEAD blob, which a partial clone may lack.
    const text = Array.from({ length: 50 }, (_, line) => `line ${line} of some content\n`).join('');
    await writeFile(join(cwd, 'long.txt'), text);
    await git(cwd, 'add', 'long.txt');
    await git(cwd, 'commit', '-qm', 'long');
    const blob = (await git(cwd, 'rev-parse', 'HEAD:long.txt')).stdout.trim();
    await git(cwd, 'mv', 'long.txt', 'renamed.txt');
    await writeFile(join(cwd, 'renamed.txt'), `${text}extra\n`);
    await git(cwd, 'add', 'renamed.txt');
    await git(cwd, 'config', 'core.repositoryformatversion', '1');
    await git(cwd, 'config', 'extensions.partialClone', 'origin');
    await git(cwd, 'config', 'remote.origin.url', 'ssh://example.invalid/repo.git');
    await git(cwd, 'config', 'remote.origin.promisor', 'true');
    await git(cwd, 'config', 'core.sshCommand', command);
    await rm(join(cwd, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    await readGitSnapshot(cwd);
    assert.equal(await exists(marker), false, 'the repository ssh command ran');
  },
);

test('without git config --show-scope (Git before 2.26), the footer shows the branch only', async t => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'tracked.txt'), 'changed\n');
  const runner = async (command, args, options) => {
    if (args.includes('--show-scope')) {
      const error = Object.assign(new Error('error: unknown option `show-scope`'), { code: 129 });
      throw error;
    }
    return exec(command, args, options);
  };
  assert.deepEqual(await readGitSnapshot(cwd, { runner }), { state: 'valid', branch: 'main', changedFiles: null });
});

test('before Git 2.36, a boolean core.fsmonitor names a hook: the footer shows the branch only', async t => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, 'config', 'core.fsmonitor', 'false');
  await writeFile(join(cwd, 'tracked.txt'), 'changed\n');
  const statuses = [];
  const runner = async (command, args, options) => {
    if (args[0] === '--version') return { stdout: 'git version 2.35.1\n', stderr: '' };
    if (args.includes('status')) statuses.push(args);
    return exec(command, args, options);
  };
  assert.deepEqual(await readGitSnapshot(cwd, { runner }), { state: 'valid', branch: 'main', changedFiles: null });
  assert.deepEqual(statuses, []);
});
