import { execFile } from 'node:child_process';
import {
  collectCleanupTargets,
  parseProcessRows,
  PS_ARGS,
  PS_COMMAND,
  readTrackedChildren,
} from '@clement_chsn/pi-shared/process-tree';

const config = JSON.parse(process.argv[2] ?? '{"groups":[],"pids":[]}');

function snapshot() {
  return new Promise(resolve => {
    execFile(PS_COMMAND, PS_ARGS, { timeout: 500, maxBuffer: 1024 * 1024 }, (_error, stdout = '') =>
      resolve(parseProcessRows(stdout)),
    );
  });
}

function sameProcess(identity, rows) {
  const row = rows.find(candidate => candidate.pid === identity.pid);
  return row?.start === identity.start && (identity.pgid === undefined || row.pgid === identity.pgid);
}

function signalTargets(targets, signal, rows) {
  for (const target of targets.groups ?? []) {
    const owned = target.identities.some(identity => {
      const row = rows.find(candidate => candidate.pid === identity.pid);
      return row?.pgid === target.pgid && row.start === identity.start;
    });
    if (owned) {
      try {
        process.kill(-target.pgid, signal);
      } catch {}
    }
  }
  for (const target of targets.pids ?? []) {
    if (sameProcess(target, rows)) {
      try {
        process.kill(target.pid, signal);
      } catch {}
    }
  }
}

function collectTargets(root, trackFile, rows) {
  return collectCleanupTargets(rows, {
    rootPid: root.pid,
    rootPgid: root.pgid,
    guardianPid: process.pid,
    trackedChildren: readTrackedChildren(trackFile),
  });
}

async function waitForWorkerExit(worker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let rows = await snapshot();
  while (sameProcess(worker, rows) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    rows = await snapshot();
  }
  return rows;
}

async function runOneShot() {
  await new Promise(resolve => setTimeout(resolve, 1_000));
  let rows = await snapshot();
  signalTargets(config, 'SIGKILL', rows);
  const lateTargets = collectTargets(config.worker, config.trackFile, rows);
  signalTargets(lateTargets, 'SIGKILL', rows);
  if (config.worker && sameProcess(config.worker, rows)) {
    try {
      process.kill(config.worker.pid, 'SIGKILL');
    } catch {}
    rows = await waitForWorkerExit(config.worker, 500);
  }
  const finalTargets = collectTargets(config.worker, config.trackFile, rows);
  signalTargets(finalTargets, 'SIGKILL', rows);
}

async function runGuardian() {
  const interval = setInterval(async () => {
    const rows = await snapshot();
    if (!sameProcess(config.worker, rows)) {
      clearInterval(interval);
      return;
    }
    if (sameProcess(config.parent, rows)) return;
    clearInterval(interval);
    const targets = collectTargets(config.worker, config.trackFile, rows);
    signalTargets(targets, 'SIGTERM', rows);
    try {
      process.kill(config.worker.pid, 'SIGTERM');
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1_000));
    let finalRows = await snapshot();
    signalTargets(targets, 'SIGKILL', finalRows);
    signalTargets(collectTargets(config.worker, config.trackFile, finalRows), 'SIGKILL', finalRows);
    if (sameProcess(config.worker, finalRows)) {
      try {
        process.kill(config.worker.pid, 'SIGKILL');
      } catch {}
      finalRows = await waitForWorkerExit(config.worker, 500);
    }
    signalTargets(collectTargets(config.worker, config.trackFile, finalRows), 'SIGKILL', finalRows);
  }, 100);
}

if (config.mode === 'guardian') await runGuardian();
else await runOneShot();
