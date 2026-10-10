import { execFile } from 'node:child_process';

const STATUS_ARGS = [
  '--no-optional-locks',
  'status',
  '--porcelain=v2',
  '-z',
  '--branch',
  '--untracked-files=all',
  '--renames',
  '--no-ahead-behind',
  // A submodule's own config could run commands too: never run git status inside one.
  '--ignore-submodules=dirty',
];
// Settings with which git status runs a command: an fsmonitor hook or a content filter.
const COMMAND_SETTINGS = [
  '--show-scope',
  '--null',
  '--get-regexp',
  '^(core\\.fsmonitor|filter\\..*\\.(clean|smudge|process))$',
];
const GIT_BOOLEAN = /^(?:true|yes|on|1|false|no|off|0|)$/i;
const RUN_OPTIONS = { timeout: 3_000, maxBuffer: 2 * 1024 * 1024 };

/** @typedef {import('node:child_process').ExecFileOptionsWithStringEncoding} RunOptions */
/** @typedef {(command: string, args: string[], options: RunOptions) => Promise<{ stdout: string, stderr: string }>} Runner */

/** @type {Runner} */
function run(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function errorMessage(error) {
  const code = error?.code ? `${error.code}: ` : '';
  return `${code}${error?.message || 'Git error'}`.replace(/[\r\n]+/g, ' ').slice(0, 240);
}

export function parseGitStatus(output) {
  const records = String(output ?? '').split('\0');
  let head = null;
  let oid = null;
  let changedFiles = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith('# branch.head ')) {
      head = record.slice('# branch.head '.length);
    } else if (record.startsWith('# branch.oid ')) {
      oid = record.slice('# branch.oid '.length);
    } else if (record.startsWith('2 ')) {
      changedFiles += 1;
      index += 1;
    } else if (/^(?:1 |u |\? )/.test(record)) {
      changedFiles += 1;
    }
  }

  const detached = head === '(detached)';
  const branch =
    detached && oid && oid !== '(initial)'
      ? `detached@${oid.slice(0, 7)}`
      : head && head !== '(detached)'
        ? head
        : null;
  return { state: 'valid', branch, changedFiles };
}

/**
 * Whether the repository's own config, rather than the user's, makes git status run a command.
 * A downloaded repository could otherwise run anything as soon as Pi starts in it.
 */
async function repositoryRunsCommands(runner, options) {
  let output;
  try {
    ({ stdout: output } = await runner('git', ['config', ...COMMAND_SETTINGS], options));
  } catch (error) {
    if (error?.code === 1) return false;
    // Git before 2.26 has no --show-scope: the repository's settings cannot be told apart.
    if (error?.code === 129) return true;
    throw error;
  }
  const entries = String(output).split('\0');
  let booleanFsmonitor = false;
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const scope = entries[index];
    // The name ends at the first newline; the value may contain others.
    const entry = entries[index + 1];
    const separator = entry.indexOf('\n');
    const name = separator < 0 ? entry : entry.slice(0, separator);
    const value = separator < 0 ? '' : entry.slice(separator + 1);
    if (!['local', 'worktree'].includes(scope)) continue;
    // A boolean core.fsmonitor selects git's own daemon or nothing.
    if (name === 'core.fsmonitor' ? !GIT_BOOLEAN.test(value) : value !== '') return true;
    if (value !== '') booleanFsmonitor = true;
  }
  return booleanFsmonitor && !(await hasBuiltinFsmonitor(runner, options));
}

/** Before Git 2.36, core.fsmonitor named a hook to run even when set to true or false. */
async function hasBuiltinFsmonitor(runner, options) {
  const { stdout } = await runner('git', ['--version'], options);
  const [major, minor] = (String(stdout).match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  return major > 2 || (major === 2 && minor >= 36);
}

/** The branch alone, read without commands that consult the index or the work tree. */
async function branchOnly(runner, options) {
  try {
    const { stdout } = await runner('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], options);
    return { state: 'valid', branch: String(stdout).trim(), changedFiles: null };
  } catch (error) {
    if (error?.code !== 1) throw error;
  }
  const { stdout } = await runner('git', ['rev-parse', '--short=7', 'HEAD'], options);
  return { state: 'valid', branch: `detached@${String(stdout).trim()}`, changedFiles: null };
}

const isAbort = (error, signal) => signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';

/** Whether git places `options.cwd` outside any work tree; false when that cannot be established. */
async function outsideWorkTree(runner, options) {
  try {
    const result = await runner('git', ['rev-parse', '--is-inside-work-tree'], options);
    return String(result.stdout).trim() !== 'true';
  } catch (probeError) {
    const diagnostic = `${probeError?.stderr || ''} ${probeError?.message || ''}`;
    return /not a git repository|not a work tree/i.test(diagnostic);
  }
}

/**
 * @param {string} cwd
 * @param {{ runner?: Runner, signal?: AbortSignal }} [options]
 */
export async function readGitSnapshot(cwd, { runner = run, signal } = {}) {
  // A partial clone would otherwise fetch missing objects through transports the repository
  // configures, such as core.sshCommand (honored since Git 2.45).
  const env = { ...process.env, GIT_NO_LAZY_FETCH: '1' };
  /** @type {RunOptions} */
  const options = { ...RUN_OPTIONS, cwd, signal, env, encoding: 'utf8' };
  try {
    if (await repositoryRunsCommands(runner, options)) return await branchOnly(runner, options);
    const result = await runner('git', STATUS_ARGS, options);
    return parseGitStatus(result.stdout);
  } catch (statusError) {
    if (isAbort(statusError, signal)) throw statusError;
    if (await outsideWorkTree(runner, options)) return { state: 'outside', branch: null, changedFiles: null };
    return {
      state: 'unknown',
      branch: null,
      changedFiles: null,
      error: errorMessage(statusError),
    };
  }
}

export function createGitCoordinator({ cwd, reader = readGitSnapshot, onSnapshot }) {
  let controller;
  let running;
  let rerun = false;
  let generation = 0;

  async function loop(myGeneration) {
    do {
      rerun = false;
      controller = new AbortController();
      try {
        const snapshot = await reader(cwd, { signal: controller.signal });
        if (generation === myGeneration && !controller.signal.aborted) onSnapshot(snapshot);
      } catch (error) {
        if (generation === myGeneration && !controller.signal.aborted) {
          onSnapshot({
            state: 'unknown',
            branch: null,
            changedFiles: null,
            error: errorMessage(error),
          });
        }
      }
    } while (generation === myGeneration && rerun);
  }

  function refresh() {
    if (running) {
      rerun = true;
      return running;
    }
    const myGeneration = generation;
    running = loop(myGeneration).finally(() => {
      running = undefined;
      controller = undefined;
    });
    return running;
  }

  function cancel() {
    generation += 1;
    rerun = false;
    controller?.abort();
  }

  return { refresh, cancel };
}
