import { readFileSync } from 'node:fs';

/** `ps` invocation whose output parseProcessRows understands. Callers choose sync or async execution. */
export const PS_COMMAND = '/bin/ps';
export const PS_ARGS = ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='];
/**
 * Environment of every `ps` call. lstart follows TZ and the locale, and identities recorded by
 * one process are compared by another (a worker and its minimal-environment guardian).
 */
export const PS_ENV = { TZ: 'UTC0', LC_ALL: 'C' };

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u;

/** `start` (lstart) is part of a process identity: a reused PID has a different start. */
export function parseProcessRows(output) {
  return String(output)
    .split('\n')
    .flatMap(line => {
      const match = ROW.exec(line);
      if (!match) return [];
      return [
        { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4], start: match[5] },
      ];
    });
}

export const isZombie = row => row.state.startsWith('Z');

/** The root and every process whose parent chain reaches it. */
export function descendantPids(rows, rootPid) {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return descendants;
}

/** JSON-lines records of spawned children: { pid, pgid, start, detached }. Unreadable files hold none. */
export function readTrackedChildren(path) {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Processes to signal when tearing down the tree under rootPid: its descendants and
 * recorded children. Members of the root's own group are targeted one PID at a time,
 * other groups as a whole. The guardian's group and the root itself are never targeted.
 * `rootPgid` is the root's group when the root no longer appears in `rows`.
 * @param {ReturnType<typeof parseProcessRows>} rows
 * @param {{ rootPid: number, rootPgid?: number, guardianPid?: number, trackedChildren?: any[] }} options
 */
export function collectCleanupTargets(rows, { rootPid, rootPgid, guardianPid, trackedChildren = [] }) {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const targets = cleanupTargets(byPid.get(rootPid)?.pgid ?? rootPgid);
  const descendants = descendantPids(rows, rootPid);
  const guardianGroup = byPid.get(guardianPid)?.pgid;
  for (const row of rows) {
    if (row.pid !== rootPid && row.pgid !== guardianGroup && descendants.has(row.pid)) targets.add(row);
  }
  for (const entry of trackedChildren) addTrackedChild(targets, entry, { rows, byPid, rootPid });
  return targets.result();
}

function cleanupTargets(ownGroup) {
  const groups = new Map();
  const pids = new Map();
  const identity = row => ({ pid: row.pid, start: row.start });
  const addGroup = (pgid, members) => {
    if (pgid === ownGroup || members.length === 0) return;
    const identities = groups.get(pgid) ?? new Map();
    for (const member of members) identities.set(member.pid, identity(member));
    groups.set(pgid, identities);
  };
  const addPid = row => pids.set(row.pid, identity(row));
  return {
    addGroup,
    addPid,
    add: row => (row.pgid === ownGroup ? addPid(row) : addGroup(row.pgid, [row])),
    result: () => ({
      groups: [...groups].map(([pgid, identities]) => ({ pgid, identities: [...identities.values()] })),
      pids: [...pids.values()],
    }),
  };
}

function addTrackedChild(targets, entry, { rows, byPid, rootPid }) {
  const current = byPid.get(entry.pid);
  if (current) {
    if (current.pgid !== entry.pgid || current.start !== entry.start) return;
    if (entry.detached) targets.addGroup(entry.pgid, [current]);
    else targets.addPid(current);
  } else if (entry.detached) {
    // A live process at the leader PID means the group ID may have been reused.
    const members = byPid.has(entry.pgid) ? [] : rows.filter(row => row.pgid === entry.pgid);
    targets.addGroup(entry.pgid, members);
  } else {
    for (const member of rows.filter(row => row.pgid === entry.pgid && row.pid !== rootPid)) targets.addPid(member);
  }
}
