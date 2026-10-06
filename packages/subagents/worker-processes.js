// Process hygiene of a worker. Extensions loaded in the child session may start processes;
// every one of them is recorded so that the worker, its guardian or the parent can stop it.
import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  collectCleanupTargets,
  parseProcessRows,
  PS_ARGS,
  PS_COMMAND,
  readTrackedChildren,
} from '@clement_chsn/pi-shared/process-tree';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
// Captured before patching: the worker's own probes and guards are never recorded.
const nativeExecFileSync = childProcess.execFileSync;
const nativeSpawn = childProcess.spawn;
const watchdogPath = fileURLToPath(new URL('./cleanup-watchdog.js', import.meta.url));
const guardEnv = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin' });

/** `{ pid, pgid, start }` of a live process, or undefined. */
function inspectProcess(pid) {
  try {
    const identity = nativeExecFileSync('/bin/ps', ['-p', String(pid), '-o', 'pgid=,lstart='], {
      encoding: 'utf8',
      timeout: 500,
    }).trim();
    const match = /^(\d+)\s+(.+)$/u.exec(identity);
    return match ? { pid, pgid: Number(match[1]), start: match[2].trim() } : undefined;
  } catch {
    return undefined;
  }
}

function recordChild(trackFile, child, args) {
  if (!child.pid || !trackFile) return child;
  const options = args.findLast(
    value => value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof URL),
  );
  const identity = inspectProcess(child.pid);
  if (identity) {
    const { pgid, start } = identity;
    try {
      appendFileSync(
        trackFile,
        `${JSON.stringify({ pid: child.pid, pgid, start, detached: options?.detached === true })}\n`,
      );
    } catch {}
  }
  return child;
}

// promisify(exec/execFile) must keep resolving { stdout, stderr } and exposing `.child`.
function promisifiedExec(wrapped) {
  return (...args) => {
    let child;
    const promise = new Promise((resolve, reject) => {
      child = wrapped(...args, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    Object.assign(promise, { child });
    return promise;
  };
}

/**
 * Records every process started through child_process into `trackFile`, as JSON lines.
 * Must run before any extension module loads, so that none keeps an unpatched reference.
 */
export function installChildTracking(trackFile) {
  for (const method of ['spawn', 'fork', 'execFile', 'exec']) {
    const native = childProcess[method];
    const wrapped = (...args) => recordChild(trackFile, native(...args), args);
    if (method === 'exec' || method === 'execFile')
      Object.defineProperty(wrapped, promisify.custom, { value: promisifiedExec(wrapped) });
    childProcess[method] = wrapped;
  }
  syncBuiltinESMExports();
}

/**
 * Starts a detached guardian that stops this worker's tree if the parent disappears.
 * Returns the worker identity and the guardian PID, which cleanup must spare.
 */
export function startGuardian(trackFile) {
  const parent = inspectProcess(process.ppid);
  const worker = inspectProcess(process.pid);
  if (!parent || !worker) return { worker, guardianPid: undefined };
  try {
    const guardian = nativeSpawn(
      process.execPath,
      [watchdogPath, JSON.stringify({ mode: 'guardian', parent, worker, trackFile })],
      { detached: true, stdio: 'ignore', env: guardEnv() },
    );
    guardian.unref();
    return { worker, guardianPid: guardian.pid };
  } catch {
    return { worker, guardianPid: undefined };
  }
}

/** Descendants of this worker and recorded children, the guardian excluded. */
export function collectTrackedTree({ trackFile, guardianPid }) {
  let rows = [];
  try {
    rows = parseProcessRows(
      nativeExecFileSync(PS_COMMAND, PS_ARGS, { encoding: 'utf8', timeout: 500, maxBuffer: 1024 * 1024 }),
    );
  } catch {}
  return collectCleanupTargets(rows, {
    rootPid: process.pid,
    guardianPid,
    trackedChildren: readTrackedChildren(trackFile),
  });
}

export function signalTree(targets, signal) {
  for (const { pgid } of targets.groups) {
    try {
      process.kill(-pgid, signal);
    } catch {}
  }
  for (const { pid } of targets.pids) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

/** Sends TERM now and leaves a detached watchdog to KILL whatever outlives this worker. */
export function launchCleanupWatchdog(targets, { worker, trackFile }) {
  signalTree(targets, 'SIGTERM');
  try {
    const watchdog = nativeSpawn(process.execPath, [watchdogPath, JSON.stringify({ ...targets, worker, trackFile })], {
      detached: true,
      stdio: 'ignore',
      env: guardEnv(),
    });
    watchdog.unref();
  } catch {}
}
