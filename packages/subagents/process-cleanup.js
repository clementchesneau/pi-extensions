// Parent-side cleanup of a worker's process tree. Every process the worker starts is either
// a descendant of it or recorded in its track file; both are observed, then signalled by group.
import { execFile } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import {
  descendantPids,
  isZombie,
  parseProcessRows,
  PS_ARGS,
  PS_COMMAND,
  readTrackedChildren,
} from '@clement_chsn/pi-shared/process-tree';

function mergeProcessSnapshots(current, observed) {
  const groups = new Set([...(current?.groups ?? []), ...observed.groups]);
  const identities = new Map(current?.identities ?? []);
  for (const [pid, pgid] of observed.identities) identities.set(pid, pgid);
  return { groups, identities };
}

function execFileBounded(command, args, timeout = 500) {
  return new Promise((resolve, reject) =>
    execFile(command, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`Process observation failed: ${error.message}`, { cause: error }));
      else resolve(stdout);
    }),
  );
}

export async function processSnapshot() {
  if (process.platform === 'win32') return [];
  const output = await execFileBounded(PS_COMMAND, PS_ARGS);
  if (!output.trim()) throw new Error('Process observation returned no rows');
  const rows = parseProcessRows(output);
  if (rows.length === 0) throw new Error('Process observation returned no parseable rows');
  return rows;
}

// Platforms where stopping a worker's process groups has been verified by the cleanup tests.
const VERIFIED_PLATFORMS = new Set(['darwin', 'linux']);

/** Rejects before a worker is spawned when its process tree could not be observed and stopped. */
export async function assertProcessCleanupAvailable(platform, readSnapshot = processSnapshot) {
  if (!VERIFIED_PLATFORMS.has(platform)) {
    throw new Error(`Subagent process cleanup is not verified on ${platform}; only macOS and Linux are supported`);
  }
  try {
    const rows = await readSnapshot();
    if (!rows.some(row => row.pid === process.pid)) throw new Error('its output does not list this process');
  } catch (error) {
    throw new Error(
      `Subagents need ${PS_COMMAND} accepting "${PS_ARGS.join(' ')}" to stop their processes ` +
        `(on Linux, install procps; BusyBox ps is not compatible): ${error.message}`,
      { cause: error },
    );
  }
}

/** @internal Pure identity check used by process-cleanup tests. */
export function resolveTrackedProcessSnapshot(entries, rows, parentPgid) {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const groups = new Set();
  const identities = new Map();
  for (const entry of entries) {
    const row = byPid.get(entry.pid);
    if (row) {
      if (row.pgid !== entry.pgid || row.start !== entry.start) continue;
      groups.add(row.pgid);
      identities.set(row.pid, { pgid: row.pgid, start: row.start });
      continue;
    }
    if (!entry.detached) continue;
    const replacementLeader = byPid.get(entry.pgid);
    if (replacementLeader) continue;
    // POSIX does not reuse a PGID while members remain. With no replacement
    // leader at the recorded PID, current members continue the recorded group.
    for (const member of rows.filter(candidate => candidate.pgid === entry.pgid)) {
      groups.add(entry.pgid);
      identities.set(member.pid, { pgid: member.pgid, start: member.start });
    }
  }
  groups.delete(parentPgid);
  return { groups, identities };
}

async function trackedGroups(filePath, readSnapshot = processSnapshot) {
  const entries = readTrackedChildren(filePath);
  if (!entries.length) return { groups: new Set(), identities: new Map() };
  const rows = await readSnapshot();
  const parentPgid = rows.find(row => row.pid === process.pid)?.pgid;
  return resolveTrackedProcessSnapshot(entries, rows, parentPgid);
}

async function descendantGroups(rootPid, readSnapshot = processSnapshot) {
  const rows = await readSnapshot();
  const descendants = descendantPids(rows, rootPid);
  const parentRow = rows.find(row => row.pid === process.pid);
  const groups = new Set(rows.filter(row => descendants.has(row.pid)).map(row => row.pgid));
  groups.delete(parentRow?.pgid);
  return {
    groups,
    identities: new Map(
      rows.filter(row => descendants.has(row.pid)).map(row => [row.pid, { pgid: row.pgid, start: row.start }]),
    ),
  };
}

/** Whether a group whose leader is gone still holds one of its observed members. */
function originalMemberAlive(snapshot, group, current) {
  return [...snapshot.identities].some(([pid, identity]) => {
    if (identity.pgid !== group || !identity.start) return false;
    const candidate = current.find(row => row.pid === pid);
    return candidate?.pgid === group && candidate.start === identity.start;
  });
}

async function verifiedLiveGroups(snapshot, readSnapshot = processSnapshot) {
  if (process.platform === 'win32') return new Set();
  // A group left with only zombies has nothing to stop, and macOS rejects killpg on it with EPERM.
  const current = (await readSnapshot()).filter(row => !isZombie(row));
  const currentGroups = new Set(current.map(row => row.pgid));
  const live = new Set();
  for (const group of snapshot.groups) {
    if (!currentGroups.has(group)) continue;
    const expectedLeader = snapshot.identities.get(group);
    const currentLeader = current.find(row => row.pid === group);
    if (expectedLeader?.start) {
      if (currentLeader ? currentLeader.start !== expectedLeader.start : !originalMemberAlive(snapshot, group, current))
        continue;
    }
    live.add(group);
  }
  return live;
}

async function killVerifiedGroups(snapshot, signal, readSnapshot = processSnapshot) {
  const liveGroups = await verifiedLiveGroups(snapshot, readSnapshot);
  for (const group of snapshot.groups) {
    if (!liveGroups.has(group) || group <= 0) continue;
    try {
      process.kill(-group, signal);
    } catch (error) {
      if (error.code === 'ESRCH') continue;
      // macOS answers EPERM while the last member is exiting (the guardian after a worker
      // crash) and before observation shows it as a zombie. Keep signalling the other
      // groups; the caller's exit wait reports any group that really survives.
      if (error.code === 'EPERM') continue;
      throw error;
    }
  }
}

async function waitForSnapshotExit(snapshot, timeoutMs, readSnapshot = processSnapshot) {
  const deadline = Date.now() + timeoutMs;
  while ((await verifiedLiveGroups(snapshot, readSnapshot)).size > 0) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

/** Process groups of one worker: its own group, its descendants' and those its track file records. */
export class WorkerProcessTree {
  #trackFile;
  #readSnapshot;
  #pid;
  #snapshot;
  #refresh;

  constructor(trackFile, readSnapshot = processSnapshot) {
    this.#trackFile = trackFile;
    this.#readSnapshot = readSnapshot;
  }

  /** Starts observing the worker process `pid`, whose group is known before any observation. */
  attach(pid) {
    this.#pid = pid;
    const groups = new Set();
    const identities = new Map();
    if (Number.isInteger(pid)) {
      groups.add(pid);
      identities.set(pid, { pgid: pid, start: undefined });
    }
    this.#snapshot = { groups, identities };
  }

  /** Adds the groups observed now; concurrent callers share one observation. */
  async refresh() {
    if (!this.#pid) return;
    if (this.#refresh) return this.#refresh;
    this.#refresh = Promise.all([
      descendantGroups(this.#pid, this.#readSnapshot),
      trackedGroups(this.#trackFile, this.#readSnapshot),
    ])
      .then(observed => {
        for (const snapshot of observed) this.#snapshot = mergeProcessSnapshots(this.#snapshot, snapshot);
      })
      .finally(() => {
        this.#refresh = undefined;
      });
    return this.#refresh;
  }

  /** Waits for an observation in flight, then observes once more. */
  async settle() {
    await this.#refresh;
    await this.refresh();
  }

  /**
   * Signals every verified live group until the tree exits: SIGTERM, then up to two SIGKILL
   * rounds. `signalWorker` receives the SIGTERM and the first SIGKILL for platforms without
   * process groups. Resolves whether the tree exited before the deadline.
   */
  async terminate(signalWorker) {
    const read = this.#readSnapshot;
    // Shutdown hooks can create processes after the initial snapshot. Re-read the
    // append-only registry after hooks run and after each signal phase.
    let snapshot = await this.#reconcile();
    await killVerifiedGroups(snapshot, 'SIGTERM', read);
    signalWorker('SIGTERM');
    await waitForSnapshotExit(snapshot, 3_000, read);
    // The second round closes the race where the worker registered a detached
    // child immediately before being killed.
    for (const round of [1, 2]) {
      snapshot = await this.#reconcile();
      if (await waitForSnapshotExit(snapshot, 0, read)) continue;
      await killVerifiedGroups(snapshot, 'SIGKILL', read);
      if (round === 1) signalWorker('SIGKILL');
      await waitForSnapshotExit(snapshot, 1_000, read);
    }
    snapshot = await this.#reconcile();
    return waitForSnapshotExit(snapshot, 0, read);
  }

  async #reconcile() {
    await this.refresh();
    return this.#snapshot;
  }

  removeTrackFile() {
    try {
      unlinkSync(this.#trackFile);
    } catch {}
  }
}
