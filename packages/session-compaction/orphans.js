import { lstat, readdir, realpath, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPrivateJson } from './private-file.js';

const uid = () => process.getuid?.();
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const privateFile = stat =>
  stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && (uid() === undefined || stat.uid === uid());
async function assertRoot(path, identity) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    !same(stat, identity) ||
    (stat.mode & 0o777) !== 0o700 ||
    (uid() !== undefined && stat.uid !== uid()) ||
    (await realpath(path)) !== path
  )
    throw new Error('Unsafe orphan directory');
}

function recognizedMarker(marker, pid) {
  return (
    marker.kind === 'pi-session-compaction' &&
    marker.version === 1 &&
    Number.isSafeInteger(marker.pid) &&
    marker.pid > 1 &&
    marker.pid === pid &&
    marker.uid === (uid() ?? null) &&
    /^[a-f0-9]{32}$/.test(marker.storeId)
  );
}

function processIsGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

/** Files of an orphan directory with their identities; throws unless every one is a known private file. */
async function orphanFiles(directory, markerIdentity) {
  const files = await readdir(directory);
  const identities = new Map();
  // Validate the complete directory before any deletion, not just a safe subset.
  for (const file of files) {
    if (file !== 'owner.json' && !/^[a-f0-9]{32}\.(json|tmp)$/.test(file)) throw new Error('Unknown orphan file');
    const stat = await lstat(join(directory, file));
    if (!privateFile(stat) || stat.size > 32768 * 7 || (file === 'owner.json' && !same(stat, markerIdentity)))
      throw new Error('Unsafe orphan file');
    identities.set(file, stat);
  }
  return { files, identities };
}

async function removeOrphan(directory, identity, { files, identities }) {
  // Keep the marker until last so interrupted cleanup can be attempted again.
  for (const file of files.filter(file => file !== 'owner.json').concat('owner.json')) {
    await assertRoot(directory, identity);
    const path = join(directory, file);
    const stat = await lstat(path);
    if (!privateFile(stat) || !same(stat, identities.get(file))) throw new Error('Orphan changed during cleanup');
    await unlink(path);
  }
  await assertRoot(directory, identity);
  await rmdir(directory);
}

/** Removes one orphan directory of process `pid` once that process is gone; whether it was removed. */
async function collectOrphan(directory, pid) {
  const identity = await lstat(directory);
  await assertRoot(directory, identity);
  const markerPath = join(directory, 'owner.json');
  const { value: marker, identity: markerIdentity } = await readPrivateJson(markerPath, {
    maxBytes: 1024,
    label: 'orphan marker',
  });
  if (!recognizedMarker(marker, pid)) throw new Error('Unrecognized orphan marker');
  if (!processIsGone(marker.pid)) return false;
  await removeOrphan(directory, identity, await orphanFiles(directory, markerIdentity));
  return true;
}

/** Best effort only: ambiguous ownership, live/reused PIDs, links and unknown files are retained. */
export async function collectOrphans({ parent = tmpdir() } = {}) {
  parent = await realpath(parent);
  let removed = 0;
  let retained = 0;
  for (const name of await readdir(parent)) {
    const match = /^pi-session-compaction-([1-9][0-9]*)-[a-zA-Z0-9]{6}$/.exec(name);
    if (!match) continue;
    try {
      if (await collectOrphan(join(parent, name), Number(match[1]))) removed++;
      else retained++;
    } catch {
      retained++; /* Uncertain ownership is never permission to recursively delete. */
    }
  }
  return { removed, retained };
}
