import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';

const LANGUAGE_IDS = new Map([
  ['.ts', 'typescript'],
  ['.tsx', 'typescriptreact'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascriptreact'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
]);
const ROOT_MARKERS = ['tsconfig.json', 'jsconfig.json', 'package.json'];
const require = createRequire(import.meta.url);
let BUNDLED_TYPESCRIPT_SERVER;
try {
  BUNDLED_TYPESCRIPT_SERVER = require.resolve('typescript-language-server/lib/cli.mjs');
} catch {
  // A damaged or development-only install can still use a server from PATH.
}

export function languageForPath(path) {
  return LANGUAGE_IDS.get(extname(path).toLowerCase());
}

function isInside(path, parent) {
  const candidate = relative(parent, path);
  return candidate === '' || (candidate !== '..' && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
}

async function exists(path, mode = constants.F_OK) {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

export async function findWorkspaceRoot(filePath, cwd) {
  const boundary = resolve(cwd);
  const absolute = resolve(filePath);
  if (!isInside(absolute, boundary)) {
    throw new Error(`File is outside the current workspace: ${absolute}`);
  }

  let directory = dirname(absolute);
  while (isInside(directory, boundary)) {
    for (const marker of ROOT_MARKERS) {
      if (await exists(join(directory, marker))) return directory;
    }
    if (directory === boundary) break;
    directory = dirname(directory);
  }
  return boundary;
}

export async function resolveTypeScriptServer(root, cwd, env = process.env, bundledServer = BUNDLED_TYPESCRIPT_SERVER) {
  const boundary = resolve(cwd);
  let directory = resolve(root);
  if (!isInside(directory, boundary)) {
    throw new Error(`Workspace root is outside the current workspace: ${directory}`);
  }

  while (isInside(directory, boundary)) {
    const command = join(directory, 'node_modules', '.bin', 'typescript-language-server');
    if (await exists(command, constants.X_OK)) return { command, args: ['--stdio'] };
    if (directory === boundary) break;
    directory = dirname(directory);
  }

  if (bundledServer && (await exists(bundledServer))) {
    return { command: process.execPath, args: [bundledServer, '--stdio'] };
  }

  for (const entry of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const command = join(entry, 'typescript-language-server');
    if (await exists(command, constants.X_OK)) return { command, args: ['--stdio'] };
  }

  throw new Error(
    'typescript-language-server was not found in the project, the extension package, or PATH. Reinstall the Pi package or install typescript-language-server locally.',
  );
}
