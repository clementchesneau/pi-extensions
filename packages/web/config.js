import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export const CONFIG_PATH = join(homedir(), '.config', 'pi-extensions', '.env');

async function readApiKey({ env, filePath, variable, service }) {
  // Even an explicitly empty environment value wins over a saved key.
  if (env[variable] !== undefined) return env[variable];
  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Cannot open ${service} configuration. Use a readable regular file, not a symlink.`, {
      cause: error,
    });
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`${service} configuration must be a regular file.`);
    if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
      throw new Error(`${service} configuration must belong to your user and have private permissions (chmod 0600).`);
    }
    if (info.size > 16_384) throw new Error(`${service} configuration exceeds the 16 KiB size limit.`);
    // Bound the read even if the file grows after stat().
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16_384) throw new Error(`${service} configuration exceeds the 16 KiB size limit.`);
    try {
      // Node's dotenv parser does not evaluate shell commands or expand variables.
      return parseEnv(buffer.toString('utf8', 0, bytesRead))[variable];
    } catch {
      throw new Error(`Cannot parse ${service} configuration. Expected ${variable}=value.`);
    }
  } finally {
    await file.close();
  }
}

export function readBraveApiKey({ env = process.env, filePath = CONFIG_PATH } = {}) {
  return readApiKey({ env, filePath, variable: 'BRAVE_API_KEY', service: 'Brave' });
}

export function readContext7ApiKey({ env = process.env, filePath = CONFIG_PATH } = {}) {
  return readApiKey({ env, filePath, variable: 'CONTEXT7_API_KEY', service: 'Context7' });
}
