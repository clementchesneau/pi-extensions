import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isZombie, parseProcessRows, PS_ARGS, PS_COMMAND, PS_ENV } from '@clement_chsn/pi-shared/process-tree';
import { appendOutput, createTaskLogs, textPageRange } from './task-logs.js';

const PAGE_LIMIT = 16 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function processRows() {
  return new Promise((resolve, reject) =>
    execFile(PS_COMMAND, PS_ARGS, { timeout: 1000, maxBuffer: 2 * 1024 * 1024, env: PS_ENV }, (error, stdout) => {
      if (error) return reject(error);
      const rows = parseProcessRows(stdout);
      if (!rows.length) return reject(new Error('Process observation returned no rows'));
      resolve(rows);
    }),
  );
}

async function groupAlive(group) {
  const rows = await processRows();
  const live = rows.some(row => row.pgid === group.pid && !isZombie(row));
  if (!live) return false;
  if (!group.leaderStart) throw new Error(`Group ${group.pid}: leader identity was not recorded`);
  const leader = rows.find(row => row.pid === group.pid);
  if (leader && leader.start !== group.leaderStart) throw new Error(`Group ${group.pid}: leader PID was reused`);
  return true;
}

async function signalGroup(group, signal) {
  if (!(await groupAlive(group))) return;
  try {
    process.kill(-group.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function waitGroup(group, ms) {
  const until = Date.now() + ms;
  do {
    if (!(await groupAlive(group))) return true;
    await sleep(30);
  } while (Date.now() < until);
  return !(await groupAlive(group));
}

async function observeDescendants(task) {
  const rows = await processRows();
  const known = task.observed;
  const byPid = new Map(rows.map(row => [row.pid, row]));
  let added;
  do {
    added = false;
    for (const row of rows) {
      // A known process can change group after observation: a detached child seen
      // between fork and setsid, or a later setsid/setpgid. Its current group counts.
      if (known.get(row.pid) !== row.start) {
        const parent = byPid.get(row.ppid);
        if (!parent || !known.has(row.ppid) || known.get(row.ppid) !== parent.start) continue;
        known.set(row.pid, row.start);
        added = true;
      }
      if (!task.groups.has(row.pgid))
        task.groups.set(row.pgid, { pid: row.pgid, leaderStart: byPid.get(row.pgid)?.start ?? null });
    }
  } while (added);
}

function spawnShell(command, cwd) {
  const child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Attach immediately: an invalid cwd can emit 'error' before the task is registered.
  child.once('error', () => {});
  if (!child.pid) throw new Error('Process failed to start');
  return child;
}

function taskRecord({ id, title, command, resume, path, logs, child }) {
  return {
    id,
    title,
    command,
    state: 'running',
    exitCode: null,
    signal: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cleanupUncertain: false,
    truncated: false,
    totalBytes: 0,
    resume,
    path,
    logs,
    pid: child.pid,
    child,
    observed: new Map(),
    groups: new Map(),
    writing: Promise.resolve(),
    stopPromise: null,
    timer: null,
  };
}

export class TaskManager {
  #tasks = new Map();
  #pendingStarts = new Set();
  #closing = false;
  #listeners = new Set();
  #init;
  /** @param {{ directory?: string, onFinish?: (task: ReturnType<TaskManager['get']>) => void }} [options] */
  constructor({ directory = tmpdir(), onFinish = () => {} } = {}) {
    this.onFinish = onFinish;
    this.#init = mkdtemp(join(directory, 'pi-background-')).then(path => {
      this.directory = path;
    });
  }
  get(id) {
    const task = this.#tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return this.#snapshot(task);
  }
  list() {
    return [...this.#tasks.values()].map(task => this.#snapshot(task));
  }
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #emit() {
    for (const listener of this.#listeners) listener();
  }
  disableResume(id) {
    const task = this.#tasks.get(id);
    if (task) task.resume = false;
  }
  #snapshot(task) {
    const {
      id,
      title,
      command,
      state,
      exitCode,
      signal,
      startedAt,
      finishedAt,
      cleanupUncertain,
      truncated,
      totalBytes,
      resume,
      stopError,
    } = task;
    return {
      id,
      title,
      command: command.slice(0, 200),
      commandTruncated: command.length > 200,
      state,
      exitCode,
      signal,
      startedAt,
      finishedAt,
      cleanupUncertain,
      truncated,
      totalBytes,
      stdoutBytes: task.logs.stdout.totalBytes,
      stderrBytes: task.logs.stderr.totalBytes,
      pid: task.pid,
      resume,
      stopError,
    };
  }
  /**
   * @param {string} command
   * @param {{ title?: string, timeoutMs?: number, resume?: boolean, cwd?: string }} [options]
   */
  async start(command, { title, timeoutMs, resume = false, cwd = process.cwd() } = {}) {
    if (process.platform === 'win32') throw new Error('Background tasks require a POSIX process-group environment');
    if (typeof command !== 'string' || !command.trim()) throw new Error('A non-empty command is required');
    if (typeof title !== 'string' || !title.trim() || [...title].length > 80)
      throw new Error('A non-empty title of at most 80 characters is required');
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1))
      throw new Error('timeoutMs must be a positive integer');
    if (this.#closing) throw new Error('Session is shutting down');
    if ([...this.#tasks.values()].filter(t => !t.finishedAt || t.stopping).length + this.#pendingStarts.size >= 4)
      throw new Error('Maximum of four concurrent tasks reached');
    // Reserve a slot synchronously before the first await. close() waits for every
    // admitted launch to finish registering (or fail) before stopping tasks.
    const pending = this.#launch(command, { title: title.trim(), timeoutMs, resume, cwd });
    this.#pendingStarts.add(pending);
    try {
      return await pending;
    } finally {
      this.#pendingStarts.delete(pending);
    }
  }
  async #launch(command, { title, timeoutMs, resume, cwd }) {
    await this.#init;
    const id = randomUUID();
    const { path, logs } = await createTaskLogs(this.directory, id);
    let child;
    try {
      child = spawnShell(command, cwd);
    } catch (error) {
      await Promise.all(Object.values(logs).map(log => rm(log.path, { force: true })));
      throw error;
    }
    const task = taskRecord({ id, title, command, resume, path, logs, child });
    this.#tasks.set(id, task);
    this.#emit();
    child.stdout.on('data', chunk => appendOutput(task, 'stdout', chunk));
    child.stderr.on('data', chunk => appendOutput(task, 'stderr', chunk));
    this.#watchExit(task);
    await this.#trackProcesses(task);
    if (timeoutMs && !task.finishedAt)
      task.timer = setTimeout(() => {
        void this.stop(id, 'timed_out').catch(() => {});
      }, timeoutMs);
    return this.#snapshot(task);
  }
  /** Settles `task.done` once the shell has closed and its output is written. */
  #watchExit(task) {
    const { child, id } = task;
    task.done = new Promise(resolve => {
      child.once('error', error => {
        task.spawnError = error.message;
      });
      child.once('close', async (code, signal) => {
        clearTimeout(task.timer);
        clearInterval(task.observer);
        await task.observing;
        await task.writing;
        task.exitCode = code;
        task.signal = signal;
        if (task.state === 'running') task.state = code === 0 ? 'completed' : 'failed';
        task.finishedAt = new Date().toISOString();
        this.#emit();
        resolve();
        if (!this.#closing) {
          // The shell may be done while a tracked detached process group still
          // runs. Reap it now instead of making /quit pay the termination grace.
          void this.stop(id).catch(error => {
            task.cleanupUncertain = true;
            task.stopError = error.message;
          });
          this.onFinish(this.#snapshot(task));
        }
      });
    });
  }
  /** Records the shell's process group, then keeps observing the groups its descendants create. */
  async #trackProcesses(task) {
    try {
      const rows = await processRows();
      const leaderStart = rows.find(row => row.pid === task.pid)?.start ?? null;
      task.groups.set(task.pid, { pid: task.pid, leaderStart });
      if (leaderStart) task.observed.set(task.pid, leaderStart);
      else if (!task.finishedAt) task.cleanupUncertain = true;
      if (!task.finishedAt) await observeDescendants(task);
    } catch {
      task.cleanupUncertain = true;
      task.groups.set(task.pid, { pid: task.pid, leaderStart: null });
    }
    if (task.finishedAt) return;
    task.observer = setInterval(() => {
      if (task.observing || task.stopPromise) return;
      task.observing = observeDescendants(task)
        .catch(error => {
          task.cleanupUncertain = true;
          task.stopError = `Process observation failed: ${error.message}`;
        })
        .finally(() => {
          task.observing = null;
        });
    }, 100);
    task.observer.unref();
  }
  async wait(id, timeoutMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000)
      throw new Error('timeoutMs must be between 0 and 300000');
    const task = this.#tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    if (task.finishedAt) return { timedOut: false, task: this.#snapshot(task) };
    await Promise.race([task.done, sleep(timeoutMs)]);
    return { timedOut: !task.finishedAt, task: this.#snapshot(task) };
  }
  async output(id, offset, maxBytes = PAGE_LIMIT, stream = 'combined') {
    const task = this.#tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PAGE_LIMIT)
      throw new Error('maxBytes must be between 1 and 16384');
    if (!['combined', 'stdout', 'stderr'].includes(stream)) throw new Error('Unknown output stream');
    await task.writing;
    const log = task.logs[stream];
    const totalBytes = log.totalBytes;
    const data = await readFile(log.path);
    const first = totalBytes - data.length;
    const requested = offset === undefined ? Math.max(first, totalBytes - maxBytes) : offset;
    if (!Number.isSafeInteger(requested) || requested < 0) throw new Error('offset must be a non-negative integer');
    const { start, end } = textPageRange({ data, first, totalBytes }, requested, maxBytes, Boolean(task.finishedAt));
    return {
      text: data.subarray(start - first, end - first).toString('utf8'),
      start,
      nextOffset: end,
      totalBytes,
      truncated: log.truncated,
      unavailableBefore: first,
      gap: requested < start,
      logError: task.logError ?? null,
    };
  }
  async stop(id, reason = 'stopped') {
    const task = this.#tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    if (task.stopPromise) return task.stopPromise;
    task.stopping = true;
    task.stopPromise = (async () => {
      clearTimeout(task.timer);
      if (!task.finishedAt) {
        task.state = reason;
        this.#emit();
      }
      try {
        await task.observing;
        await observeDescendants(task);
      } catch (error) {
        task.cleanupUncertain = true;
        task.stopError = `Process observation failed: ${error.message}`;
      }
      for (const group of task.groups.values()) {
        try {
          await signalGroup(group, 'SIGTERM');
          if (!(await waitGroup(group, 600))) {
            await signalGroup(group, 'SIGKILL');
            if (!(await waitGroup(group, 1200))) throw new Error(`Group ${group.pid} is still alive`);
          }
        } catch (error) {
          task.cleanupUncertain = true;
          task.stopError = error.message;
        }
      }
      // A shell can exit before its descendants; all observed groups are checked.
      if (!task.finishedAt) {
        await Promise.race([task.done, sleep(1500)]);
        if (!task.finishedAt) {
          task.cleanupUncertain = true;
          task.stopError ??= 'Process exit was not observed';
        }
      }
      return this.#snapshot(task);
    })().finally(() => {
      task.stopping = false;
    });
    return task.stopPromise;
  }
  async close() {
    this.#closing = true;
    await Promise.allSettled([...this.#pendingStarts]);
    await this.#init;
    await Promise.all(
      [...this.#tasks.keys()].map(id =>
        this.stop(id).catch(error => {
          const task = this.#tasks.get(id);
          task.cleanupUncertain = true;
          task.stopError = error.message;
        }),
      ),
    );
    await rm(this.directory, { recursive: true, force: true });
    return this.list().filter(task => task.cleanupUncertain);
  }
}
