import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveHostPiRuntime } from '../../../packages/subagents/pi-compatibility.js';

// Explicit target for SDK integrations; never infer an SDK from the worker cwd.
const entry = realpathSync(
  process.env.PI_TEST_HOST_ENTRY ?? fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')),
);
export const sdk = await import(pathToFileURL(entry).href);
export const piRuntime = resolveHostPiRuntime({ sdk });
const packageRoot = sdk.getPackageDir();
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
// Exercise the declared executable, including its bundled virtual SDK.
export const cli = join(packageRoot, typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.pi);
