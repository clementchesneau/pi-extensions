import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { piRuntime, sdk } from './fixtures/subagents/host-runtime.mjs';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = process.cwd();

test('diagnostic accepts a compatible external SDK with a different release from any cwd and pnpm', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-external-sdk-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const version = '123.4.5';
  mkdirSync(join(directory, 'dist'));
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version,
      type: 'module',
      exports: { '.': { import: './dist/index.js' } },
    }),
  );
  writeFileSync(
    join(directory, 'dist/index.js'),
    `export * from ${JSON.stringify(pathToFileURL(piRuntime.entry).href)};\nexport const VERSION = ${JSON.stringify(version)};\n`,
  );
  const executable = join(directory, 'pi');
  writeFileSync(
    executable,
    `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nimport { resolveHostPiRuntime } from ${JSON.stringify(pathToFileURL(join(root, 'packages/subagents/pi-compatibility.js')).href)};\nif (process.argv.includes('--version')) console.log(${JSON.stringify(version)});\nelse writeFileSync(process.env.PI_COMPAT_PROBE_RESULT, JSON.stringify(resolveHostPiRuntime({ packageDir: ${JSON.stringify(directory)} })));\n`,
  );
  chmodSync(executable, 0o755);
  const env = { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}` };
  const direct = spawnSync(process.execPath, [join(root, 'scripts/check-pi-compat.mjs')], {
    cwd: directory,
    env,
    encoding: 'utf8',
  });
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(direct.stdout, /Pi 123\.4\.5: host SDK contracts available/);
  const pnpm = spawnSync('pnpm', ['check:pi'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(pnpm.status, 0, pnpm.stderr);
  assert.match(pnpm.stdout, /Pi 123\.4\.5: host SDK contracts available/);
});

test('diagnostic follows a shell launcher outside the actual Pi package', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-shell-launcher-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(sdk.getPackageDir(), 'package.json'), 'utf8'));
  const cli = join(sdk.getPackageDir(), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.pi);
  const executable = join(directory, 'pi');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`);
  chmodSync(executable, 0o755);
  const env = { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}` };
  const result = spawnSync(process.execPath, [join(root, 'scripts/check-pi-compat.mjs')], {
    cwd: directory,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`Pi ${sdk.VERSION}: host SDK contracts available`));
});

test('pnpm check:pi checks the external CLI rather than the package-local pi shim', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-compat-cli-'));
  try {
    const executable = join(directory, 'pi');
    writeFileSync(executable, '#!/bin/sh\nprintf "0.0.0\\n"\n');
    chmodSync(executable, 0o755);
    const env = { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}` };
    const direct = spawnSync(process.execPath, ['scripts/check-pi-compat.mjs'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(direct.status, 1, direct.stderr);
    assert.ok(direct.stderr.includes('External Pi launcher did not expose an accessible host SDK'));

    const pnpm = spawnSync('pnpm', ['check:pi'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(pnpm.status, 1, `stdout: ${pnpm.stdout}\nstderr: ${pnpm.stderr}`);
    assert.ok(pnpm.stderr.includes('External Pi launcher did not expose an accessible host SDK'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
