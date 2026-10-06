import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CONFIG_VERSION = 1;
export const DEFAULT_SUBAGENT_CONFIG = Object.freeze({ version: CONFIG_VERSION, autoDelegate: true, maxConcurrent: 4 });
const LOCK_TIMEOUT_MS = 1_000;
const LOCK_RETRY_MS = 25;

export function defaultConfigPath() {
  return join(homedir(), '.config', 'pi-extensions', 'subagents.json');
}

export function validateSubagentConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Subagent configuration must be an object');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'autoDelegate,maxConcurrent,version')
    throw new Error('Subagent configuration has unknown or missing fields');
  if (value.version !== CONFIG_VERSION) throw new Error(`Subagent configuration version must be ${CONFIG_VERSION}`);
  if (typeof value.autoDelegate !== 'boolean') throw new Error('Subagent configuration autoDelegate must be a boolean');
  if (!Number.isSafeInteger(value.maxConcurrent) || value.maxConcurrent < 1)
    throw new Error('Subagent configuration maxConcurrent must be a positive safe integer');
  return { version: CONFIG_VERSION, autoDelegate: value.autoDelegate, maxConcurrent: value.maxConcurrent };
}

async function readExisting(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`Cannot read subagent configuration: ${error.message}`, { cause: error });
  }
  try {
    return validateSubagentConfig(JSON.parse(text));
  } catch (error) {
    throw new Error(`Invalid subagent configuration: ${error.message}`, { cause: error });
  }
}

async function acquireLock(path) {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      return async () => {
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== 'EEXIST')
        throw new Error(`Cannot lock subagent configuration: ${error.message}`, { cause: error });
      if (Date.now() >= deadline)
        throw new Error('Cannot lock subagent configuration before the deadline', { cause: error });
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function atomicWrite(path, config) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.subagents.json`);
  try {
    await writeFile(temporary, `${JSON.stringify(config)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new Error(`Cannot save subagent configuration: ${error.message}`, { cause: error });
  }
}

export async function loadSubagentConfig({ path = defaultConfigPath() } = {}) {
  const existing = await readExisting(path);
  if (existing) return existing;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await acquireLock(path);
  try {
    const concurrent = await readExisting(path);
    if (concurrent) return concurrent;
    await atomicWrite(path, DEFAULT_SUBAGENT_CONFIG);
    return { ...DEFAULT_SUBAGENT_CONFIG };
  } finally {
    await release();
  }
}

/**
 * @param {unknown} patch
 * @param {{ path?: string, validate?: (candidate: ReturnType<typeof validateSubagentConfig>) => unknown }} [options]
 */
export async function updateSubagentConfig(patch, { path = defaultConfigPath(), validate } = {}) {
  if (
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    Object.keys(patch).some(key => !['autoDelegate', 'maxConcurrent'].includes(key))
  ) {
    throw new Error('Invalid subagent configuration update');
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await acquireLock(path);
  try {
    const current = (await readExisting(path)) ?? DEFAULT_SUBAGENT_CONFIG;
    const next = validateSubagentConfig({ ...current, ...patch });
    await validate?.(next);
    await atomicWrite(path, next);
    return next;
  } finally {
    await release();
  }
}

export async function saveSubagentConfig(value, { path = defaultConfigPath() } = {}) {
  const config = validateSubagentConfig(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await acquireLock(path);
  try {
    // Check the previous file so corrupt data never gets silently replaced.
    await readExisting(path);
    await atomicWrite(path, config);
    return config;
  } finally {
    await release();
  }
}
