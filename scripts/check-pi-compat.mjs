import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { loadHostPiRuntime } from '../packages/subagents/pi-compatibility.js';

let probeDirectory;
try {
  // pnpm prepends development shims; diagnose the user's external installation.
  const directories = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(
      entry => entry && !(basename(resolve(entry)) === '.bin' && basename(dirname(resolve(entry))) === 'node_modules'),
    );
  let executable;
  for (const directory of directories) {
    const candidate = join(directory, 'pi');
    try {
      accessSync(candidate, constants.X_OK);
      executable = realpathSync(candidate);
      break;
    } catch {}
  }
  if (!executable) throw new Error('No external Pi CLI can be found outside node_modules/.bin');
  const observed = execFileSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, PATH: directories.join(delimiter) },
  }).trim();

  // Ask the launched process itself: a pnpm/shell launcher can live anywhere.
  // This loads only a private diagnostic extension and sends no model prompt.
  probeDirectory = mkdtempSync(join(tmpdir(), 'pi-runtime-probe-'));
  const home = join(probeDirectory, 'home');
  mkdirSync(home, { mode: 0o700 });
  const report = join(probeDirectory, 'runtime.json');
  const extension = join(probeDirectory, 'probe.mjs');
  const compatibilityModule = new URL('../packages/subagents/pi-compatibility.js', import.meta.url).href;
  writeFileSync(
    extension,
    `import * as sdk from '@earendil-works/pi-coding-agent';
import { writeFileSync } from 'node:fs';
import { resolveHostPiRuntime } from ${JSON.stringify(compatibilityModule)};
export default function probe(pi) {
  let result;
  try { result = resolveHostPiRuntime({ sdk }); }
  catch (error) { result = { error: error.message }; }
  writeFileSync(process.env.PI_COMPAT_PROBE_RESULT, JSON.stringify(result), { mode: 0o600 });
  pi.on('session_start', (_event, ctx) => ctx.shutdown());
}
`,
    { mode: 0o600 },
  );
  let probeError;
  try {
    execFileSync(
      executable,
      [
        '--mode',
        'rpc',
        '--no-session',
        '--no-extensions',
        '--no-context-files',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '-e',
        extension,
      ],
      {
        cwd: probeDirectory,
        input: '',
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          PATH: directories.join(delimiter),
          HOME: home,
          PI_CODING_AGENT_DIR: join(probeDirectory, 'agent'),
          PI_OFFLINE: '1',
          PI_COMPAT_PROBE_RESULT: report,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    probeError = error;
  }
  let descriptor;
  try {
    const file = statSync(report);
    if (!file.isFile() || file.size > 64 * 1024) throw new Error('Invalid runtime probe report');
    descriptor = JSON.parse(readFileSync(report, 'utf8'));
  } catch {
    throw new Error('External Pi launcher did not expose an accessible host SDK (private no-prompt probe failed)', {
      cause: probeError,
    });
  }
  if (typeof descriptor?.error === 'string') throw new Error(`External Pi host SDK probe failed: ${descriptor.error}`);
  const sdk = await loadHostPiRuntime(descriptor);
  if (observed !== sdk.VERSION) throw new Error(`External Pi CLI ${observed} differs from its SDK ${sdk.VERSION}`);
  console.log(`Pi ${sdk.VERSION}: host SDK contracts available (${descriptor.entry}).`);
  console.log(
    'This diagnoses the external installation, not an already-open Pi session; worker readiness is checked at launch.',
  );
} catch (error) {
  console.error(`Pi compatibility check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (probeDirectory) rmSync(probeDirectory, { recursive: true, force: true });
}
