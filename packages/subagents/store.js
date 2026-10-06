import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

const STORE_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function valid(value, pattern = SAFE_ID) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('Invalid subagent artifact identifier');
  return value;
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function atomicPrivateWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new Error(`Cannot write subagent artifact: ${error.message}`, { cause: error });
  }
}

function serializableAgent(agent) {
  const clone = structuredClone(agent);
  delete clone.runtime;
  delete clone.privateCapabilities;
  for (const run of clone.runs ?? []) {
    delete run.completion;
    if (run.resultStored) delete run.result;
  }
  return clone;
}

function boundedUtf8Prefix(buffer, maxBytes) {
  const ceiling = Math.min(buffer.length, maxBytes);
  for (let length = ceiling; length >= Math.max(0, ceiling - 3); length -= 1) {
    try {
      return { bytes: length, text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)) };
    } catch {}
  }
  return { bytes: 0, text: '' };
}

const validPageBounds = (cursor, maxBytes, maxLines) =>
  Number.isSafeInteger(cursor) &&
  cursor >= 0 &&
  Number.isSafeInteger(maxBytes) &&
  maxBytes >= 1 &&
  maxBytes <= 24 * 1024 &&
  Number.isSafeInteger(maxLines) &&
  maxLines >= 1 &&
  maxLines <= 600;

/** `page` cut after its `maxLines`-th line feed, when text follows it. */
function firstLines(page, maxLines) {
  let lineCount = 0;
  for (let index = 0; index < page.text.length; index += 1) {
    if (page.text[index] !== '\n') continue;
    lineCount += 1;
    if (lineCount < maxLines) continue;
    if (index + 1 >= page.text.length) return page;
    const text = page.text.slice(0, index + 1);
    return { text, bytes: Buffer.byteLength(text) };
  }
  return page;
}

export class SubagentStore {
  #writes = new Map();

  /** @param {{ agentDir?: string, ownerSessionId?: string, ephemeral?: boolean }} [options] */
  constructor({ agentDir, ownerSessionId, ephemeral = false } = {}) {
    if (typeof agentDir !== 'string' || !agentDir || typeof ownerSessionId !== 'string')
      throw new TypeError('agentDir and ownerSessionId are required');
    this.agentDir = agentDir;
    this.ownerSessionId = valid(ownerSessionId);
    this.ephemeral = ephemeral;
  }

  root() {
    return join(this.agentDir, 'subagents', this.ownerSessionId);
  }

  agentPath(agentId) {
    return join(this.root(), valid(agentId, UUID));
  }

  async ensureAgentDirectory(agentId) {
    const path = this.agentPath(agentId);
    await privateDirectory(path);
    return path;
  }

  async saveAgent(agent) {
    if (!agent || agent.ownerSessionId !== this.ownerSessionId)
      throw new Error('Subagent artifact belongs to another session');
    const snapshot = serializableAgent(agent);
    const key = this.agentPath(agent.agentId);
    const previous = this.#writes.get(key) ?? Promise.resolve();
    const write = previous
      .catch(() => {})
      .then(async () => {
        const path = await this.ensureAgentDirectory(snapshot.agentId);
        await atomicPrivateWrite(
          join(path, 'metadata.json'),
          `${JSON.stringify({ version: STORE_VERSION, agent: snapshot })}\n`,
        );
      });
    this.#writes.set(key, write);
    try {
      await write;
    } finally {
      if (this.#writes.get(key) === write) this.#writes.delete(key);
    }
  }

  async loadAgent(agentId) {
    const path = join(this.agentPath(agentId), 'metadata.json');
    let value;
    try {
      value = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot read subagent metadata: ${error.message}`, { cause: error });
    }
    if (!value || value.version !== STORE_VERSION || !value.agent || value.agent.agentId !== agentId)
      throw new Error('Unsupported or invalid subagent metadata');
    return value.agent;
  }

  /** @param {{ onError?: (agentId: string, error: unknown) => void }} [options] */
  async loadAgents({ onError } = {}) {
    let entries;
    try {
      entries = await readdir(this.root(), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw new Error(`Cannot list subagent metadata: ${error.message}`, { cause: error });
    }
    const agents = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      try {
        agents.push(await this.loadAgent(entry.name));
      } catch (error) {
        if (!onError) throw error;
        onError(entry.name, error);
      }
    }
    return agents;
  }

  async saveResult(agentId, runId, text) {
    if (typeof text !== 'string') throw new TypeError('Subagent result must be text');
    valid(runId);
    const path = this.agentPath(agentId);
    await privateDirectory(path);
    await atomicPrivateWrite(join(path, `result-${runId}.txt`), text);
  }

  /**
   * @param {string} agentId
   * @param {{ sessionFile?: string, cursor?: number, maxBytes?: number, maxLines?: number }} [options]
   */
  async readTranscript(agentId, { sessionFile, cursor = 0, maxBytes = 24 * 1024, maxLines = 600 } = {}) {
    const directory = await realpath(this.agentPath(agentId));
    if (!sessionFile) {
      const names = (await readdir(directory)).filter(name => name.endsWith('.jsonl')).sort();
      if (names.length === 0) return { text: '', cursor, nextCursor: undefined, truncated: false, totalBytes: 0 };
      sessionFile = join(directory, names.at(-1));
    }
    const resolved = await realpath(sessionFile);
    if (!resolved.startsWith(`${directory}${sep}`) || !resolved.endsWith('.jsonl'))
      throw new Error('Child transcript is outside the private subagent directory');
    return this.#readPage(resolved, { cursor, maxBytes, maxLines });
  }

  async readResult(agentId, runId, options = {}) {
    valid(runId);
    return this.#readPage(join(this.agentPath(agentId), `result-${runId}.txt`), options);
  }

  async #readPage(path, { cursor = 0, maxBytes = 24 * 1024, maxLines = 600 } = {}) {
    if (!validPageBounds(cursor, maxBytes, maxLines)) throw new TypeError('Invalid subagent result cursor or bounds');
    const info = await stat(path);
    if (cursor > info.size) throw new Error('Subagent result cursor is outside the artifact');
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(info.size - cursor, maxBytes + 4));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);
      const prefix = boundedUtf8Prefix(buffer.subarray(0, bytesRead), maxBytes);
      if (bytesRead > 0 && prefix.bytes === 0)
        throw new RangeError('maxBytes is too small for the next Unicode character');
      const page = firstLines(prefix, maxLines);
      const nextCursor = cursor + page.bytes;
      return {
        text: page.text,
        cursor,
        nextCursor: nextCursor < info.size ? nextCursor : undefined,
        truncated: nextCursor < info.size,
        totalBytes: info.size,
      };
    } finally {
      await handle.close();
    }
  }

  async cleanup() {
    if (this.ephemeral) await rm(this.root(), { recursive: true, force: true });
  }
}
