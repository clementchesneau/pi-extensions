// Output logs of a background task: combined and per-stream files, bounded to their last
// LOG_LIMIT bytes, read back as pages of complete UTF-8 characters.
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOG_LIMIT = 10 * 1024 * 1024;
// Large enough to batch writes and amortize the tail rewrite past LOG_LIMIT.
const QUEUE_LIMIT = 4 * 1024 * 1024;
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

function setReading(task, reading) {
  for (const output of [task.child.stdout, task.child.stderr]) {
    if (reading) output.resume();
    else output.pause();
  }
}

/** Writes every chunk queued so far as one batch per log, then lets the pipes flow again. */
async function writeQueued(task) {
  const { logs } = task;
  const batch = task.queued;
  task.queued = [];
  const bytes = batch.reduce((sum, { chunk }) => sum + chunk.length, 0);
  try {
    await writeLog(logs.combined, Buffer.concat(batch.map(({ chunk }) => chunk)));
    for (const stream of ['stdout', 'stderr']) {
      const chunks = batch.filter(entry => entry.stream === stream).map(({ chunk }) => chunk);
      if (chunks.length) await writeLog(logs[stream], Buffer.concat(chunks));
    }
    task.totalBytes = logs.combined.totalBytes;
    task.truncated = logs.combined.truncated;
  } finally {
    task.queuedBytes -= bytes;
    if (task.queuedBytes < QUEUE_LIMIT) setReading(task, true);
  }
}

/**
 * Queues `chunk` for the combined log and its stream's log, after earlier chunks. Past
 * QUEUE_LIMIT unwritten bytes, the task's pipes pause: a faster writer waits in its pipe
 * instead of growing Pi's memory.
 */
export function appendOutput(task, stream, chunk) {
  task.queued.push({ stream, chunk });
  task.queuedBytes += chunk.length;
  if (task.queuedBytes >= QUEUE_LIMIT) setReading(task, false);
  if (task.queued.length > 1) return;
  task.writing = task.writing
    .then(() => writeQueued(task))
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
