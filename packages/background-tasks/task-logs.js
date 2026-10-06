// Output logs of a background task: combined and per-stream files, bounded to their last
// LOG_LIMIT bytes, read back as pages of complete UTF-8 characters.
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOG_LIMIT = 10 * 1024 * 1024;
const isContinuation = byte => (byte & 0xc0) === 0x80;

function completeUtf8End(data, end) {
  let lead = end - 1;
  while (lead >= 0 && isContinuation(data[lead])) lead--;
  if (lead < 0) return end;
  const byte = data[lead];
  const length =
    byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xc2 && byte <= 0xdf ? 2 : 1;
  return end - lead < length ? lead : end;
}

export async function createTaskLogs(directory, id) {
  const path = join(directory, `${id}.log`);
  const logs = Object.fromEntries(
    ['combined', 'stdout', 'stderr'].map(stream => [
      stream,
      { path: stream === 'combined' ? path : `${path}.${stream}`, totalBytes: 0, truncated: false },
    ]),
  );
  for (const log of Object.values(logs)) {
    const file = await open(log.path, 'wx', 0o600);
    await file.close();
  }
  return { path, logs };
}

/** Appends `chunk` to `log`, then keeps only its last LOG_LIMIT bytes. */
async function writeLog(log, chunk) {
  log.totalBytes += chunk.length;
  const file = await open(log.path, 'a', 0o600);
  try {
    await file.write(chunk);
  } finally {
    await file.close();
  }
  if (log.totalBytes - (log.droppedBytes ?? 0) > LOG_LIMIT) {
    const data = await readFile(log.path);
    const tail = data.subarray(-LOG_LIMIT);
    await writeFile(log.path, tail, { mode: 0o600 });
    log.droppedBytes = log.totalBytes - tail.length;
    log.truncated = true;
  }
}

/** Queues `chunk` for the combined log and its stream's log, after earlier chunks. */
export function appendOutput(task, stream, chunk) {
  const { logs } = task;
  task.writing = task.writing
    .then(async () => {
      for (const log of [logs.combined, logs[stream]]) await writeLog(log, chunk);
      task.totalBytes = logs.combined.totalBytes;
      task.truncated = logs.combined.truncated;
    })
    .catch(error => {
      task.logError = error.message;
    });
}

/**
 * Byte range of a text page from `requested`, in a log whose retained bytes `data` start at
 * `first`. Page boundaries are byte offsets, but text pages must contain complete UTF-8
 * characters. A small request may consume up to four bytes to make progress.
 */
export function textPageRange({ data, first, totalBytes }, requested, maxBytes, finished) {
  let start = Math.min(Math.max(requested, first), totalBytes);
  while (start < totalBytes && isContinuation(data[start - first])) start++;
  let end = Math.min(start + maxBytes, totalBytes);
  if (end < totalBytes) {
    while (end > start && isContinuation(data[end - first])) end--;
    if (end === start) {
      end = Math.min(start + 1, totalBytes);
      while (end < totalBytes && isContinuation(data[end - first])) end++;
    }
  }
  if (end === totalBytes && !finished) end = Math.max(start, completeUtf8End(data, end - first) + first);
  return { start, end };
}
