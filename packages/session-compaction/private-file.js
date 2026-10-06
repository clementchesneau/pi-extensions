import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

const uid = () => process.getuid?.();
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const isPrivateFile = (stat, maxBytes) =>
  stat.isFile() &&
  stat.nlink === 1 &&
  (stat.mode & 0o777) === 0o600 &&
  (uid() === undefined || stat.uid === uid()) &&
  stat.size <= maxBytes;

/** Refuse special files before opening; nonblocking mode also closes the FIFO replacement race. */
export async function readPrivateJson(path, { maxBytes, label }) {
  const identity = await lstat(path);
  if (!isPrivateFile(identity, maxBytes)) throw new Error(`Unsafe ${label}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!same(stat, identity) || !isPrivateFile(stat, maxBytes)) throw new Error(`Unsafe ${label}`);
    // Bound actual reads too: a same-user append after fstat must not defeat the size limit.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error(`Unsafe ${label}: size limit exceeded`);
    return { value: JSON.parse(buffer.subarray(0, length).toString('utf8')), identity };
  } finally {
    await handle.close();
  }
}
