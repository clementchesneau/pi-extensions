import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createSubagentRuntime } from '../packages/subagents/runtime.js';
import {
  resolveHostPiRuntime,
  loadHostPiRuntime,
  loadParentPiHost,
  validatePiRuntimeDescriptor,
} from '../packages/subagents/pi-compatibility.js';

function fixture(t, version = '123.4.5', exports = '') {
  const directory = mkdtempSync(join(tmpdir(), 'pi host '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
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
  writeFileSync(join(directory, 'dist/index.js'), `export const VERSION = '${version}';\n${exports}`);
  return { directory, descriptor: resolveHostPiRuntime({ entryPoint: join(directory, 'dist/index.js') }) };
}

test('a failed default SDK import is reported without retrying the same missing package', async () => {
  let attempts = 0;
  const missing = new Error('SDK unavailable in this embedding');
  await assert.rejects(
    loadParentPiHost({
      loadSdk: async () => {
        attempts += 1;
        throw missing;
      },
    }),
    error => error === missing,
  );
  assert.equal(attempts, 1);
});

test('host SDK resolves explicitly without a release allowlist', async () => {
  const descriptor = resolveHostPiRuntime({ sdk });
  assert.equal(descriptor.version, sdk.VERSION);
  assert.equal((await loadHostPiRuntime(descriptor)).SessionManager, sdk.SessionManager);
});

test('a replaced host installation is refused rather than using the local SDK', t => {
  const { directory, descriptor } = fixture(t);
  assert.deepEqual(validatePiRuntimeDescriptor(descriptor), descriptor);
  assert.throws(
    () => resolveHostPiRuntime({ sdk: { ...sdk, VERSION: 'older', getPackageDir: () => directory } }),
    /restart Pi/i,
  );
  assert.throws(() => validatePiRuntimeDescriptor({ ...descriptor, version: 'older' }), /restart Pi/i);
});

test('missing ESM entry or required capability fails explicitly', async t => {
  const { descriptor } = fixture(t);
  await assert.rejects(loadHostPiRuntime(descriptor), /required capability/);
  rmSync(descriptor.entry);
  assert.throws(() => validatePiRuntimeDescriptor(descriptor), /SDK entry/i);
});

test('same-version replacement of a cached SDK or its imported module is refused', async t => {
  const { directory } = fixture(t);
  const entry = join(directory, 'dist/index.js');
  const nativeEntry = pathToFileURL(join(sdk.getPackageDir(), 'dist/index.js')).href;
  writeFileSync(join(directory, 'dist/implementation.js'), "export const marker = 'old';");
  writeFileSync(
    entry,
    `export * from ${JSON.stringify(nativeEntry)};\nexport const VERSION = '123.4.5';\nexport { marker } from './implementation.js';\n`,
  );
  const descriptor = resolveHostPiRuntime({ entryPoint: entry });
  assert.equal((await loadHostPiRuntime(descriptor)).marker, 'old');
  const runtime = createSubagentRuntime({
    version: 1,
    piRuntime: descriptor,
    instanceId: 'same-version-replacement',
    cwd: process.cwd(),
    agentDir: directory,
    model: { provider: 'test', id: 'test' },
    thinkingLevel: 'off',
    allowedTools: [],
    resources: {},
  });
  // Same pathname, version, length and restored mtime: ctime still invalidates
  // the content-hash cache, while the parent's ESM namespace remains cached.
  const implementation = join(directory, 'dist/implementation.js');
  const before = statSync(implementation);
  writeFileSync(implementation, "export const marker = 'new';");
  utimesSync(implementation, before.atime, before.mtime);
  await assert.rejects(loadHostPiRuntime(descriptor), /files changed.*restart Pi/);
  assert.throws(() => validatePiRuntimeDescriptor(descriptor), /files changed.*restart Pi/);
  await assert.rejects(runtime.start(), /files changed.*restart Pi/);
  assert.equal(runtime.pid, undefined, 'no child is forked from a stale parent baseline');
  assert.equal(runtime.status, 'failed');
});

for (const kind of ['direct', 'alias', 'resource']) {
  test(`replacement of a transitively loaded ${kind === 'resource' ? 'runtime resource' : `extensionless module (${kind})`} is refused`, async t => {
    const { directory } = fixture(t);
    const dist = join(directory, 'dist');
    const entry = join(dist, 'index.js');
    const implementation = join(dist, kind === 'resource' ? 'a-impl.data' : 'a-impl');
    const nativeEntry = pathToFileURL(join(sdk.getPackageDir(), 'dist/index.js')).href;
    if (kind === 'alias') symlinkSync('a-impl', join(dist, 'z-impl.js'));
    writeFileSync(implementation, kind === 'resource' ? 'old' : "export const marker = 'old';");
    const marker =
      kind === 'resource'
        ? "import { readFileSync } from 'node:fs'; export const marker = readFileSync(new URL('./a-impl.data', import.meta.url), 'utf8');"
        : `export { marker } from './${kind === 'alias' ? 'z-impl.js' : 'a-impl'}';`;
    writeFileSync(
      entry,
      `export * from ${JSON.stringify(nativeEntry)};\nimport { SessionManager as NativeSessionManager } from ${JSON.stringify(nativeEntry)};\nexport class SessionManager extends NativeSessionManager {}\nexport const VERSION = '123.4.5';\nexport const getPackageDir = () => ${JSON.stringify(directory)};\n${marker}\n`,
    );
    const descriptor = resolveHostPiRuntime({ entryPoint: entry });
    const parent = await loadHostPiRuntime(descriptor);
    assert.equal(parent.marker, 'old');
    assert.deepEqual(resolveHostPiRuntime({ sdk: parent }), descriptor);
    const runtime = createSubagentRuntime({
      version: 1,
      piRuntime: descriptor,
      instanceId: `transitive-${kind}`,
      cwd: process.cwd(),
      agentDir: directory,
      model: { provider: 'test', id: 'test' },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: {},
    });
    const before = statSync(implementation);
    writeFileSync(implementation, kind === 'resource' ? 'new' : "export const marker = 'new';");
    utimesSync(implementation, before.atime, before.mtime);
    const fresh = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { marker } from ${JSON.stringify(pathToFileURL(entry).href)}; console.log(marker);`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(fresh.stdout.trim(), 'new');
    assert.equal(parent.marker, 'old', 'the cached parent and fresh process disagree');
    assert.throws(() => validatePiRuntimeDescriptor(descriptor), /files changed.*restart Pi/);
    assert.throws(() => resolveHostPiRuntime({ sdk: parent }), /files changed.*restart Pi/);
    await assert.rejects(loadHostPiRuntime(descriptor), /files changed.*restart Pi/);
    await assert.rejects(runtime.start(), /files changed.*restart Pi/);
    assert.equal(runtime.pid, undefined, 'no worker is forked');
    assert.equal(runtime.status, 'failed');
  });
}

for (const target of ['sdk', 'cli']) {
  test(`replacing an extensionless declared ${target} target is refused before fork`, async t => {
    const { directory } = fixture(t);
    const dist = join(directory, 'dist');
    const entry = join(dist, 'index.js');
    const cli = join(dist, 'z-cli.js');
    const nativeEntry = pathToFileURL(join(sdk.getPackageDir(), 'dist/index.js')).href;
    const source = marker =>
      `export * from ${JSON.stringify(nativeEntry)};\nimport { SessionManager as NativeSessionManager } from ${JSON.stringify(nativeEntry)};\nexport class SessionManager extends NativeSessionManager {}\nexport const VERSION = '123.4.5';\nexport const getPackageDir = () => ${JSON.stringify(directory)};\nexport const marker = '${marker}';\n`;
    unlinkSync(entry);
    symlinkSync('a-sdk', entry);
    symlinkSync('a-cli', cli);
    writeFileSync(join(dist, 'a-sdk'), source('old'));
    writeFileSync(join(dist, 'a-cli'), "console.log('old');");
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: '@earendil-works/pi-coding-agent',
        version: '123.4.5',
        type: 'module',
        exports: { '.': { import: './dist/index.js' } },
        bin: { pi: './dist/z-cli.js' },
      }),
    );
    const descriptor = resolveHostPiRuntime({ entryPoint: entry });
    const parent = await loadHostPiRuntime(descriptor);
    assert.equal(parent.marker, 'old');
    assert.deepEqual(resolveHostPiRuntime({ sdk: parent }), descriptor);
    const runtime = createSubagentRuntime({
      version: 1,
      piRuntime: descriptor,
      instanceId: `extensionless-${target}`,
      cwd: process.cwd(),
      agentDir: directory,
      model: { provider: 'test', id: 'test' },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: {},
    });
    const changed = join(dist, target === 'sdk' ? 'a-sdk' : 'a-cli');
    const before = statSync(changed);
    writeFileSync(changed, target === 'sdk' ? source('new') : "console.log('new');");
    utimesSync(changed, before.atime, before.mtime);
    const fresh = spawnSync(
      process.execPath,
      target === 'sdk'
        ? [
            '--input-type=module',
            '-e',
            `import { marker } from ${JSON.stringify(pathToFileURL(entry).href)}; console.log(marker);`,
          ]
        : [cli],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(fresh.stdout.trim(), 'new');
    assert.equal(parent.marker, 'old', 'the parent SDK remains cached');
    assert.throws(() => validatePiRuntimeDescriptor(descriptor), /files changed.*restart Pi/);
    assert.throws(() => resolveHostPiRuntime({ sdk: parent }), /files changed.*restart Pi/);
    await assert.rejects(loadHostPiRuntime(descriptor), /files changed.*restart Pi/);
    await assert.rejects(runtime.start(), /files changed.*restart Pi/);
    assert.equal(runtime.pid, undefined, 'no worker is forked from a stale baseline');
    assert.equal(runtime.status, 'failed');
  });
}

for (const kind of ['file', 'directory']) {
  test(`retargeting an internal ${kind} symlink to an already visited module is refused`, async t => {
    const { directory } = fixture(t);
    const dist = join(directory, 'dist');
    const nativeEntry = pathToFileURL(join(sdk.getPackageDir(), 'dist/index.js')).href;
    if (kind === 'directory') {
      mkdirSync(join(dist, 'a-old'));
      mkdirSync(join(dist, 'b-new'));
    }
    const oldPath = kind === 'file' ? 'a-old.js' : 'a-old/marker.js';
    const newPath = kind === 'file' ? 'b-new.js' : 'b-new/marker.js';
    writeFileSync(join(dist, oldPath), "export const marker = 'old';");
    writeFileSync(join(dist, newPath), "export const marker = 'new';");
    const link = join(dist, kind === 'file' ? 'z-selected.js' : 'z-selected');
    symlinkSync(kind === 'file' ? oldPath : 'a-old', link);
    symlinkSync('.', join(dist, 'cycle'));
    const entry = join(dist, 'index.js');
    writeFileSync(
      entry,
      `export * from ${JSON.stringify(nativeEntry)};\nexport const VERSION = '123.4.5';\nexport { marker } from './${kind === 'file' ? 'z-selected.js' : 'z-selected/marker.js'}';\n`,
    );
    const descriptor = resolveHostPiRuntime({ entryPoint: entry });
    assert.deepEqual(validatePiRuntimeDescriptor(descriptor), descriptor, 'unchanged aliases and cycles are stable');
    const parent = await loadHostPiRuntime(descriptor);
    assert.equal(parent.marker, 'old');
    const runtime = createSubagentRuntime({
      version: 1,
      piRuntime: descriptor,
      instanceId: `symlink-${kind}`,
      cwd: process.cwd(),
      agentDir: directory,
      model: { provider: 'test', id: 'test' },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: {},
    });
    unlinkSync(link);
    symlinkSync(kind === 'file' ? newPath : 'b-new', link);
    const fresh = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { marker } from ${JSON.stringify(pathToFileURL(entry).href)}; console.log(marker);`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(fresh.stdout.trim(), 'new');
    assert.equal(parent.marker, 'old', 'the parent namespace remains cached');
    await assert.rejects(loadHostPiRuntime(descriptor), /files changed.*restart Pi/);
    await assert.rejects(runtime.start(), /files changed.*restart Pi/);
    assert.equal(runtime.pid, undefined, 'no mission worker is forked');
  });
}

test('retargeting the CLI launcher cannot renew the process baseline after helper reload', t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-launcher-baseline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const launcher = join(root, 'pi');
  const moduleUrl = new URL('../packages/subagents/pi-compatibility.js', import.meta.url).href;
  const nativeEntry = pathToFileURL(join(sdk.getPackageDir(), 'dist/index.js')).href;
  const directories = [join(root, 'a-old'), join(root, 'b-new')];
  const script = `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlinkSync, unlinkSync } from 'node:fs';
import { loadParentPiHost } from ${JSON.stringify(moduleUrl)};
const first = await loadParentPiHost();
assert.equal(first.error, undefined);
if (process.env.PI_BASELINE_TEST_PHASE === 'fresh') {
  assert.equal(first.sdk.marker, 'new');
  console.log('restart-accepted');
} else {
  assert.equal(first.sdk.marker, 'old');
  const unchangedModule = await import(${JSON.stringify(`${moduleUrl}?unchanged-launcher-reload`)});
  const unchanged = await unchangedModule.loadParentPiHost();
  assert.equal(unchanged.error, undefined, 'an unchanged launcher remains valid after reload');
  assert.equal(unchanged.sdk, first.sdk);
  unlinkSync(${JSON.stringify(launcher)});
  symlinkSync(${JSON.stringify(join(directories[1], 'dist/cli.js'))}, ${JSON.stringify(launcher)});
  const reloaded = await import(${JSON.stringify(`${moduleUrl}?launcher-baseline-reload`)});
  const next = await reloaded.loadParentPiHost();
  assert.match(next.error?.message ?? '', /restart Pi/, 'a new SDK must not replace the original process baseline');
  assert.equal(next.sdk, first.sdk, 'archive access retains the original namespace');
  const freshSdk = await import(${JSON.stringify(pathToFileURL(join(directories[1], 'dist/index.js')).href)});
  assert.notEqual(freshSdk.SessionManager, first.sdk.SessionManager);
  assert.throws(() => reloaded.resolveHostPiRuntime({ sdk: freshSdk }), /restart Pi/);
  unlinkSync(${JSON.stringify(launcher)});
  const missing = await reloaded.loadParentPiHost();
  assert.match(missing.error?.message ?? '', /restart Pi/, 'a missing launcher cannot erase the process baseline');
  assert.equal(missing.sdk, first.sdk);
  symlinkSync(${JSON.stringify(join(directories[1], 'dist/cli.js'))}, ${JSON.stringify(launcher)});
  const restarted = spawnSync(process.execPath, [${JSON.stringify(launcher)}], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PI_BASELINE_TEST_PHASE: 'fresh' } });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(restarted.stdout.trim(), 'restart-accepted');
  console.log('replacement-refused');
}
`;
  for (const [index, directory] of directories.entries()) {
    mkdirSync(join(directory, 'dist'), { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: '@earendil-works/pi-coding-agent',
        version: '123.4.5',
        type: 'module',
        exports: { '.': { import: './dist/index.js' } },
        bin: { pi: './dist/cli.js' },
      }),
    );
    writeFileSync(
      join(directory, 'dist/index.js'),
      `export * from ${JSON.stringify(nativeEntry)};\nimport { SessionManager as NativeSessionManager } from ${JSON.stringify(nativeEntry)};\nexport class SessionManager extends NativeSessionManager {}\nexport const VERSION = '123.4.5';\nexport const getPackageDir = () => ${JSON.stringify(directory)};\nexport const marker = '${index === 0 ? 'old' : 'new'}';\n`,
    );
    writeFileSync(join(directory, 'dist/cli.js'), script);
  }
  symlinkSync(join(directories[0], 'dist/cli.js'), launcher);
  const result = spawnSync(process.execPath, [launcher], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, PI_BASELINE_TEST_PHASE: 'switch' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'replacement-refused');
});

test('initialization baseline survives reloading the extension module and SDK namespace wrappers', async t => {
  const { directory } = fixture(t);
  const parentSdk = {
    ...sdk,
    VERSION: '123.4.5',
    getPackageDir: () => directory,
    SessionManager: class extends sdk.SessionManager {},
  };
  resolveHostPiRuntime({ sdk: parentSdk });
  writeFileSync(join(directory, 'dist/index.js'), "export const VERSION = '123.4.5'; export const changed = true;");
  const reloaded = await import(
    new URL('../packages/subagents/pi-compatibility.js?reload-baseline-test', import.meta.url).href
  );
  assert.throws(() => reloaded.resolveHostPiRuntime({ sdk: { ...parentSdk } }), /files changed.*restart Pi/);
});

test('a same-version SDK with a different source is refused', async () => {
  const descriptor = resolveHostPiRuntime({ sdk });
  await assert.rejects(
    loadHostPiRuntime(descriptor, { expectedSdk: { ...sdk, createAgentSessionServices: () => {} } }),
    /SDK source differs/,
  );
});

test('an override pointing outside a Pi package is not accepted', t => {
  const { directory } = fixture(t);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'not-pi', version: sdk.VERSION }));
  assert.throws(() => resolveHostPiRuntime({ sdk: { ...sdk, getPackageDir: () => directory } }), /Pi package/i);
});
