import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export const MAX_RECORD_BYTES = 32 * 1024 * 1024;
export const MAX_WRITE_QUEUE_BYTES = 32 * 1024 * 1024;

export class ProtocolError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ProtocolError';
  }
}

/** Strict LF-delimited JSON decoder. */
export class JsonlDecoder {
  #buffer = '';
  #decoder = new StringDecoder('utf8');
  #ended = false;
  #maxRecordBytes;
  #onRecord;

  constructor(onRecord, { maxRecordBytes = MAX_RECORD_BYTES } = {}) {
    this.#onRecord = onRecord;
    this.#maxRecordBytes = maxRecordBytes;
  }

  write(chunk) {
    if (this.#ended) throw new ProtocolError('Cannot write after JSONL EOF');
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    this.#drain(false);
  }

  end(chunk) {
    if (this.#ended) return;
    if (chunk !== undefined) this.write(chunk);
    this.#buffer += this.#decoder.end();
    this.#ended = true;
    this.#drain(true);
  }

  #drain(atEof) {
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#emit(line);
    }
    if (Buffer.byteLength(this.#buffer, 'utf8') > this.#maxRecordBytes) {
      throw new ProtocolError(`JSONL record exceeds ${this.#maxRecordBytes} bytes`);
    }
    if (atEof && this.#buffer.length > 0) {
      const line = this.#buffer;
      this.#buffer = '';
      this.#emit(line);
    }
  }

  #emit(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (Buffer.byteLength(line, 'utf8') > this.#maxRecordBytes) {
      throw new ProtocolError(`JSONL record exceeds ${this.#maxRecordBytes} bytes`);
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      throw new ProtocolError(`Invalid JSONL JSON: ${cause.message}`, { cause });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ProtocolError('JSONL record must be a JSON object');
    }
    this.#onRecord(value);
  }
}

/** Routes a decoded record: events to subscribers, a response to its pending request. */
function dispatchRecord(record, { pending, subscribers, rejectAll }) {
  if (record.type !== 'response') {
    for (const subscriber of subscribers) subscriber(record);
    return;
  }
  if (typeof record.id !== 'string' || !pending.has(record.id)) {
    rejectAll(new ProtocolError(`Unknown response id: ${String(record.id)}`));
    return;
  }
  const item = pending.get(record.id);
  if (record.command !== item.command) {
    rejectAll(new ProtocolError(`Response command mismatch for ${record.id}`));
    return;
  }
  pending.delete(record.id);
  clearTimeout(item.timer);
  if (record.success !== true) {
    item.reject(new ProtocolError(record.error || `RPC ${item.command} failed`));
  } else {
    item.resolve(record.data);
  }
}

/** Feeds `readable` to `decoder` and reports stream failures; returns the function that stops listening. */
function watchStreams(readable, writable, decoder, fail) {
  const onData = chunk => {
    try {
      decoder.write(chunk);
    } catch (error) {
      fail(error);
    }
  };
  const onEnd = () => {
    try {
      decoder.end();
    } catch (error) {
      fail(error);
      return;
    }
    fail(new ProtocolError('RPC readable stream ended'));
  };
  const onReadableError = error =>
    fail(new ProtocolError(`RPC readable stream failed: ${error.message}`, { cause: error }));
  const onWritableError = error =>
    fail(new ProtocolError(`RPC writable stream failed: ${error.message}`, { cause: error }));
  readable.on('data', onData);
  readable.on('end', onEnd);
  readable.on('error', onReadableError);
  writable.on('error', onWritableError);
  return () => {
    readable.off('data', onData);
    readable.off('end', onEnd);
    readable.off('error', onReadableError);
    writable.off('error', onWritableError);
  };
}

/** Serializes line writes, refusing a line once `maxBytes` would be queued. */
function createWriteQueue(writable, maxBytes, { isClosed, fail }) {
  let queuedBytes = 0;
  let writeTail = Promise.resolve();
  return (line, item) => {
    const bytes = Buffer.byteLength(line);
    if (queuedBytes + bytes > maxBytes) {
      return Promise.reject(new ProtocolError(`RPC write queue exceeds ${maxBytes} bytes`));
    }
    queuedBytes += bytes;
    const operation = writeTail.then(
      () =>
        new Promise((resolve, reject) => {
          if (item?.cancelled) {
            resolve();
            return;
          }
          if (isClosed() || writable.destroyed || writable.writableEnded) {
            reject(new ProtocolError('RPC writable stream is closed'));
            return;
          }
          writable.write(line, error => (error ? reject(error) : resolve()));
        }),
    );
    writeTail = operation
      .catch(() => {})
      .finally(() => {
        queuedBytes -= bytes;
      });
    return operation.catch(error => {
      const wrapped =
        error instanceof ProtocolError
          ? error
          : new ProtocolError(`RPC write failed: ${error.message}`, { cause: error });
      fail(wrapped);
      throw wrapped;
    });
  };
}

function rejectPending(pending, error) {
  for (const item of pending.values()) {
    item.cancelled = true;
    clearTimeout(item.timer);
    item.reject(error);
  }
  pending.clear();
}

/** Bounded request/response adapter for the Pi RPC subset used by subagents. */
export function createRpcConnection({
  readable,
  writable,
  requestTimeoutMs = 10_000,
  maxRecordBytes = MAX_RECORD_BYTES,
  maxWriteQueueBytes = MAX_WRITE_QUEUE_BYTES,
}) {
  let closed = false;
  const pending = new Map();
  const subscribers = new Set();
  const closeSubscribers = new Set();

  const rejectAll = error => {
    if (closed) return;
    closed = true;
    rejectPending(pending, error);
    for (const subscriber of closeSubscribers) subscriber(error);
  };

  const decoder = new JsonlDecoder(record => dispatchRecord(record, { pending, subscribers, rejectAll }), {
    maxRecordBytes,
  });
  const fail = error => rejectAll(error instanceof Error ? error : new ProtocolError(String(error)));
  const unwatch = watchStreams(readable, writable, decoder, fail);
  const enqueue = createWriteQueue(writable, maxWriteQueueBytes, { isClosed: () => closed, fail });

  const request = (command, fields = {}, { timeoutMs = requestTimeoutMs } = {}) => {
    if (closed) return Promise.reject(new ProtocolError('RPC connection is closed'));
    const id = randomUUID();
    let resolve;
    let reject;
    const response = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const item = { command, resolve, reject, timer: undefined, cancelled: false };
    const timer = setTimeout(() => {
      item.cancelled = true;
      fail(new ProtocolError(`RPC ${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    item.timer = timer;
    pending.set(id, item);
    enqueue(`${JSON.stringify({ id, type: command, ...fields })}\n`, item).catch(error => {
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id);
      clearTimeout(timer);
      item.reject(error);
    });
    return response;
  };

  const close = (reason = new ProtocolError('RPC connection closed')) => {
    unwatch();
    rejectAll(reason);
  };

  const notify = (type, fields = {}) => {
    if (closed) return Promise.reject(new ProtocolError('RPC connection is closed'));
    return enqueue(`${JSON.stringify({ type, ...fields })}\n`);
  };

  return {
    request,
    send(type, fields = {}, options) {
      return request(type, fields, options);
    },
    notify,
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    subscribeClose(listener) {
      closeSubscribers.add(listener);
      return () => closeSubscribers.delete(listener);
    },
    close,
    get closed() {
      return closed;
    },
  };
}
