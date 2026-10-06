import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCleanupTargets, descendantPids, parseProcessRows } from '../packages/shared/process-tree.js';

const row = (pid, ppid, pgid, state = 'S') => ({ pid, ppid, pgid, state, start: `start-${pid}` });
const identities = (...pids) => pids.map(pid => ({ pid, start: `start-${pid}` }));

test('ps rows keep lstart with its inner spaces and skip malformed lines', () => {
  const output =
    '  101   100   100 S+   Sat Oct  4 11:37:00 2026\nnot a row\n 102 100 102 Z Sat Oct  4 11:38:00 2026 \n';
  assert.deepEqual(parseProcessRows(output), [
    { pid: 101, ppid: 100, pgid: 100, state: 'S+', start: 'Sat Oct  4 11:37:00 2026' },
    { pid: 102, ppid: 100, pgid: 102, state: 'Z', start: 'Sat Oct  4 11:38:00 2026' },
  ]);
});

test('descendants follow parent links transitively from the root', () => {
  const rows = [row(100, 1, 100), row(101, 100, 100), row(102, 101, 102), row(300, 1, 300)];
  assert.deepEqual([...descendantPids(rows, 100)].sort(), [100, 101, 102]);
});

test('cleanup targets own-group descendants by PID, other groups whole, never the guardian group', () => {
  const rows = [
    row(100, 1, 100),
    row(101, 100, 100),
    row(102, 100, 102),
    row(103, 102, 102),
    row(200, 1, 200),
    row(201, 100, 200),
    row(300, 1, 300),
  ];
  assert.deepEqual(collectCleanupTargets(rows, { rootPid: 100, guardianPid: 200 }), {
    groups: [{ pgid: 102, identities: identities(102, 103) }],
    pids: identities(101),
  });
});

test('recorded children are targeted only while their identity or group can be trusted', () => {
  const rows = [
    row(100, 1, 100),
    row(401, 1, 400),
    row(600, 1, 600),
    row(611, 1, 600),
    row(700, 1, 700),
    row(801, 1, 800),
  ];
  const trackedChildren = [
    // Detached leader exited, no process holds its PID: surviving members continue the group.
    { pid: 400, pgid: 400, start: 'start-400', detached: true },
    // Another process now holds the leader PID: the group ID may have been reused.
    { pid: 610, pgid: 600, start: 'start-610', detached: true },
    // Same PID, different start: a reused PID, not the recorded child.
    { pid: 700, pgid: 700, start: 'other', detached: false },
    // Exited non-detached child: its remaining group members are targeted one by one.
    { pid: 800, pgid: 800, start: 'start-800', detached: false },
  ];
  assert.deepEqual(collectCleanupTargets(rows, { rootPid: 100, trackedChildren }), {
    groups: [{ pgid: 400, identities: identities(401) }],
    pids: identities(801),
  });
});

test('the root group is never signalled as a whole, even through a recorded detached child', () => {
  const rows = [row(100, 1, 100), row(101, 1, 100)];
  const trackedChildren = [{ pid: 101, pgid: 100, start: 'start-101', detached: true }];
  assert.deepEqual(collectCleanupTargets(rows, { rootPid: 100, trackedChildren }), { groups: [], pids: [] });
});
