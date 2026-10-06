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
];
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
  /** @type {RunOptions} */
  const options = { ...RUN_OPTIONS, cwd, signal, encoding: 'utf8' };
  try {
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
