import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findWorkspaceRoot,
  languageForPath,
  resolveTypeScriptServer,
} from '../packages/code-intelligence/languages.js';
import { LspClient } from '../packages/code-intelligence/client.js';
import { CodeNavManager } from '../packages/code-intelligence/manager.js';
import codeIntelligenceExtension, { createCodeNavTool } from '../packages/code-intelligence/index.js';
import { formatCodeNavOutput } from '../packages/code-intelligence/output.js';
import { Check } from 'typebox/value';
import { createFakePi } from './fixtures/fake-pi.mjs';

const fakeServer = join(process.cwd(), 'tests', 'fixtures', 'fake-lsp-server.mjs');

async function readLog(path) {
  try {
    return (await import('node:fs/promises'))
      .readFile(path, 'utf8')
      .then(text => text.trim().split('\n').filter(Boolean).map(JSON.parse));
  } catch {
    return [];
  }
}

test('LSP protocol detects supported languages, roots, and local, bundled, or PATH servers', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-code-nav-languages-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const nested = join(cwd, 'packages', 'app', 'src');
  await mkdir(join(cwd, 'node_modules', '.bin'), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(cwd, 'package.json'), '{}');
  await writeFile(join(cwd, 'packages', 'app', 'tsconfig.json'), '{}');
  const source = join(nested, 'view.tsx');
  await writeFile(source, 'export const view = 1;');

  assert.equal(languageForPath(source), 'typescriptreact');
  assert.equal(languageForPath(join(nested, 'entry.cjs')), 'javascript');
  assert.equal(languageForPath(join(nested, 'readme.md')), undefined);
  assert.equal(await findWorkspaceRoot(source, cwd), join(cwd, 'packages', 'app'));

  const local = join(cwd, 'node_modules', '.bin', 'typescript-language-server');
  await writeFile(local, '#!/bin/sh\n');
  await chmod(local, 0o755);
  assert.deepEqual(await resolveTypeScriptServer(join(cwd, 'packages', 'app'), cwd, { PATH: '' }), {
    command: local,
    args: ['--stdio'],
  });

  await rm(local);
  const bundled = await resolveTypeScriptServer(cwd, cwd, { PATH: '' });
  assert.equal(bundled.command, process.execPath);
  assert.equal(bundled.args.at(-1), '--stdio');
  assert.match(bundled.args[0], /typescript-language-server.*cli\.mjs/);

  const pathBin = join(cwd, 'path-bin');
  await mkdir(pathBin);
  const pathServer = join(pathBin, 'typescript-language-server');
  await writeFile(pathServer, '#!/bin/sh\n');
  await chmod(pathServer, 0o755);
  assert.deepEqual(await resolveTypeScriptServer(cwd, cwd, { PATH: [pathBin, '/missing'].join(delimiter) }, null), {
    command: pathServer,
    args: ['--stdio'],
  });

  await assert.rejects(resolveTypeScriptServer(cwd, cwd, { PATH: '' }, null), /typescript-language-server.*install/i);
  await assert.rejects(findWorkspaceRoot('/tmp/outside.ts', cwd), /outside.*workspace/i);

  const dotted = join(cwd, '..generated');
  await mkdir(dotted);
  const dottedSource = join(dotted, 'inside.ts');
  await writeFile(dottedSource, 'export const inside = true;');
  assert.equal(await findWorkspaceRoot(dottedSource, cwd), cwd);
});

test('LSP actions initialize once, route all actions, and reject stale unversioned diagnostics', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-client-'));
  const source = join(root, 'sample.ts');
  const log = join(root, 'server.log');
  await writeFile(source, 'export const value = 1;\n');
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_LSP_LOG: log, FAKE_DIAGNOSTICS_DELAY: '300' },
    requestTimeoutMs: 1000,
    diagnosticsTimeoutMs: 500,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  const symbols = await client.navigate({ action: 'symbols', path: source });
  assert.equal(symbols[0].name, 'outer');
  const workspace = await client.navigate({ action: 'symbols', path: source, query: 'find-me' });
  assert.equal(workspace[0].name, 'workspace:find-me');
  const definition = await client.navigate({ action: 'definition', path: source, line: 2, column: 3 });
  assert.equal(definition.range.start.line, 3);
  const references = await client.navigate({ action: 'references', path: source, line: 2, column: 3 });
  assert.equal(references.length, 1);
  const hover = await client.navigate({ action: 'hover', path: source, line: 2, column: 3 });
  assert.equal(hover.contents.value, '**number**');
  const diagnosticsStarted = Date.now();
  const diagnostics = await client.navigate({ action: 'diagnostics', path: source });
  assert.equal(diagnostics.items[0].message, 'fresh diagnostic');
  assert.equal(diagnostics.incomplete, true);
  assert.ok(
    Date.now() - diagnosticsStarted >= 250,
    'must wait for the delayed fresh publication, not return queued stale diagnostics',
  );
  const repeatedDiagnostics = await client.navigate({ action: 'diagnostics', path: source });
  assert.equal(repeatedDiagnostics.items[0].message, 'fresh diagnostic');

  await new Promise(resolve => setTimeout(resolve, 20));
  const events = await readLog(log);
  assert.equal(events.filter(event => event.method === 'initialize').length, 1);
  assert.ok(events.some(event => event.method === 'initialized'));
  assert.ok(events.some(event => event.method === 'workspace/configuration'));
  assert.ok(events.some(event => event.method === 'client/registerCapability'));
  assert.ok(events.some(event => event.method === 'workspace/workspaceFolders'));
  const opens = events.filter(event => event.method === 'textDocument/didOpen');
  const changes = events.filter(event => event.method === 'textDocument/didChange');
  assert.equal(opens.length, 1);
  assert.deepEqual(
    changes.map(event => event.params.textDocument.version),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.equal(events.filter(event => event.method === 'textDocument/didClose').length, 0);
  assert.ok(
    !events.some(
      event => event.method === 'workspace/symbol' && event.params.query === '__pi_code_nav_diagnostics_barrier__',
    ),
  );
  const positioned = events.find(event => event.method === 'textDocument/definition');
  assert.deepEqual(positioned.params.position, { line: 1, character: 2 });
  assert.ok(client.stderr.length <= 16_384);
});

test('LSP refreshes previously opened dependencies from disk before querying another document', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-dependency-refresh-'));
  const dependency = join(root, 'a.ts');
  const consumer = join(root, 'b.ts');
  const log = join(root, 'server.log');
  await writeFile(dependency, 'export const value = 1;\n');
  await writeFile(consumer, "import { value } from './a.js';\nexport const result = value;\n");
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_LSP_LOG: log },
    requestTimeoutMs: 1000,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  await client.navigate({ action: 'symbols', path: dependency });
  await writeFile(dependency, "export const value = 'text';\n");
  await client.navigate({ action: 'symbols', path: consumer });

  const events = await readLog(log);
  const refresh = events.find(
    event =>
      event.method === 'textDocument/didChange' &&
      event.params.textDocument.uri.endsWith('/a.ts') &&
      event.params.contentChanges[0].text.includes("'text'"),
  );
  const consumerRequest = events.findIndex(
    event => event.method === 'textDocument/documentSymbol' && event.params.textDocument.uri.endsWith('/b.ts'),
  );
  assert.ok(refresh, 'the already-open dependency must be refreshed');
  assert.ok(events.indexOf(refresh) < consumerRequest, 'dependency refresh must precede the consumer request');
});

test('LSP diagnostics remain fresh when another action targets the same document concurrently', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-concurrent-diagnostics-'));
  const source = join(root, 'sample.ts');
  await writeFile(source, 'const value = 1;\n');
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_DIAGNOSTICS_DELAY: '300' },
    requestTimeoutMs: 1000,
    diagnosticsTimeoutMs: 700,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  const diagnostics = client.navigate({ action: 'diagnostics', path: source });
  await new Promise(resolve => setTimeout(resolve, 50));
  const hover = await client.navigate({ action: 'hover', path: source, line: 1, column: 1 });
  assert.equal(hover.contents.value, '**number**');
  assert.equal((await diagnostics).items[0].message, 'fresh diagnostic');
});

test('LSP diagnostics time out when no post-probe analysis publication arrives', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-close-diagnostics-'));
  const source = join(root, 'sample.ts');
  await writeFile(source, 'const value: string = 1;\n');
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_DIAGNOSTICS_SKIP_FRESH: '1' },
    requestTimeoutMs: 1000,
    diagnosticsTimeoutMs: 100,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  await client.navigate({ action: 'symbols', path: source });
  await assert.rejects(
    client.navigate({ action: 'diagnostics', path: source }),
    /timed out waiting for the diagnostic analysis probe/i,
  );
});

test('LSP diagnostics fall back to a syntax probe when checking suppresses grammar diagnostics', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-probe-fallback-'));
  const source = join(root, 'sample.js');
  await writeFile(source, '// @ts-nocheck\nexport const value = 1;\n');
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_SKIP_GRAMMAR_PROBE: '1', FAKE_DIAGNOSTICS_EMPTY: '1' },
    requestTimeoutMs: 1000,
    diagnosticsTimeoutMs: 40,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  const diagnostics = await client.navigate({ action: 'diagnostics', path: source });
  assert.deepEqual(diagnostics.items, []);
});

test('LSP diagnostics accept a genuine empty result immediately after symbols', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-empty-diagnostics-'));
  const source = join(root, 'sample.ts');
  await writeFile(source, 'export const value = 123;\n');
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_DIAGNOSTICS_EMPTY: '1' },
    requestTimeoutMs: 1000,
    diagnosticsTimeoutMs: 150,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  await client.navigate({ action: 'symbols', path: source });
  const diagnostics = await client.navigate({ action: 'diagnostics', path: source });
  assert.deepEqual(diagnostics.items, []);
  assert.equal(diagnostics.incomplete, true);
});

test('LSP diagnostics reject stale unversioned publications after the analysis proof', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-stale-after-probe-'));
  const source = join(root, 'sample.ts');
  await writeFile(source, 'export const value = 123;\n');
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_SKIP_NON_PROBE_FRESH: '1', FAKE_PROBE_STALE_AFTER_MS: '20' },
    requestTimeoutMs: 1000,
    diagnosticsTimeoutMs: 100,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  await client.navigate({ action: 'symbols', path: source });
  const diagnostics = await client.navigate({ action: 'diagnostics', path: source });
  assert.deepEqual(diagnostics.items, []);
  assert.ok(!diagnostics.items.some(item => item.message === 'stale diagnostic'));
});

test('LSP diagnostics reject an unversioned probe publication from a previous call', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-previous-probe-'));
  const source = join(root, 'sample.ts');
  await writeFile(source, 'export const value = 1;\n');
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_REPLAY_PREVIOUS_PROBE: '1' },
    requestTimeoutMs: 1000,
    diagnosticsTimeoutMs: 40,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  const first = await client.navigate({ action: 'diagnostics', path: source });
  assert.equal(first.items[0].code, 42);
  await writeFile(source, 'export const changed = 2;\n');
  await assert.rejects(
    client.navigate({ action: 'diagnostics', path: source }),
    /Timed out waiting for the diagnostic analysis probe/,
  );
});

test('LSP diagnostic probe preserves leading TypeScript directives', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-directive-diagnostics-'));
  const source = join(root, 'sample.ts');
  const log = join(root, 'server.log');
  await writeFile(source, '// @ts-nocheck\nexport const value: string = 1;\n');
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_LSP_LOG: log },
    requestTimeoutMs: 1000,
    diagnosticsTimeoutMs: 100,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  await client.navigate({ action: 'diagnostics', path: source });
  const events = await readLog(log);
  const probeChange = events.find(
    event =>
      event.method === 'textDocument/didChange' &&
      event.params.contentChanges[0].text.includes('pi-code-nav diagnostic probe'),
  );
  const text = probeChange.params.contentChanges[0].text;
  assert.ok(text.indexOf('// @ts-nocheck') < text.indexOf('pi-code-nav diagnostic probe'));
  assert.ok(text.indexOf('pi-code-nav diagnostic probe') < text.indexOf('export const value'));
});

test('LSP diagnostic probe preserves JavaScript directive prologues', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-strict-directive-'));
  const source = join(root, 'sample.js');
  const log = join(root, 'server.log');
  await writeFile(source, '"use strict"; function f() { var eval = 1; }\n');
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_LSP_LOG: log },
    requestTimeoutMs: 1000,
    diagnosticsTimeoutMs: 100,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  await client.navigate({ action: 'diagnostics', path: source });
  const events = await readLog(log);
  const probeChange = events.find(
    event =>
      event.method === 'textDocument/didChange' &&
      event.params.contentChanges[0].text.includes('pi-code-nav diagnostic probe'),
  );
  const text = probeChange.params.contentChanges[0].text;
  assert.ok(text.indexOf('"use strict"') < text.indexOf('pi-code-nav diagnostic probe'));
});

test('LSP diagnostic probe does not split continued string expressions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-continued-expression-'));
  const source = join(root, 'sample.ts');
  const log = join(root, 'server.log');
  await writeFile(source, '"hello"\n.trim();\n');
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_LSP_LOG: log },
    requestTimeoutMs: 1000,
    diagnosticsTimeoutMs: 50,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  await client.navigate({ action: 'diagnostics', path: source });
  const events = await readLog(log);
  const probeChange = events.find(
    event =>
      event.method === 'textDocument/didChange' &&
      event.params.contentChanges[0].text.includes('pi-code-nav diagnostic probe'),
  );
  const text = probeChange.params.contentChanges[0].text;
  assert.ok(text.indexOf('pi-code-nav diagnostic probe') < text.indexOf('"hello"'));
});

test('LSP diagnostic probe is never inserted inside trailing directive comments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-directive-comment-'));
  const source = join(root, 'sample.ts');
  await writeFile(source, '"use strict"; /* explanation\ncontinued */\nexport const value = 1;\n');
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: process.env,
    requestTimeoutMs: 1000,
    diagnosticsTimeoutMs: 50,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  const diagnostics = await client.navigate({ action: 'diagnostics', path: source });
  assert.equal(diagnostics.items[0].code, 42);
});

test('LSP diagnostics preserve end-of-file errors alongside the probe diagnostic', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-eof-diagnostics-'));
  const source = join(root, 'sample.ts');
  await writeFile(source, 'export const value = `unterminated;\n');
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_PROBE_EOF_CODE: '1160', FAKE_SKIP_NON_PROBE_FRESH: '1' },
    requestTimeoutMs: 1000,
    diagnosticsTimeoutMs: 100,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  const diagnostics = await client.navigate({ action: 'diagnostics', path: source });
  assert.deepEqual(
    diagnostics.items.map(item => item.code),
    [1160],
  );
  assert.equal(diagnostics.items[0].range.start.line, 0);
});

test('LSP diagnostics aggregate progressive publications until the bounded deadline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-progressive-diagnostics-'));
  const source = join(root, 'sample.ts');
  await writeFile(source, 'const value: string = 1;\n');
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_DIAGNOSTICS_PROGRESSIVE_DELAY: '200' },
    requestTimeoutMs: 1000,
    diagnosticsTimeoutMs: 350,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  const started = Date.now();
  const diagnostics = await client.navigate({ action: 'diagnostics', path: source });
  assert.equal(diagnostics.items[0].message, 'fresh diagnostic');
  assert.equal(diagnostics.incomplete, true);
  assert.ok(
    Date.now() - started >= 300,
    'must collect later publications instead of returning the initial empty result',
  );
});

test('real TypeScript diagnostics preserve declaration-file TS1036 and TS1039 errors', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-real-declarations-'));
  const declaration = join(root, 'broken.d.ts');
  const moduleDeclaration = join(root, 'broken.d.mts');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { skipLibCheck: false } }));
  await writeFile(declaration, 'export {}; console.log("bad");\n');
  await writeFile(moduleDeclaration, 'export const value: string = "bad";\n');
  const server = await resolveTypeScriptServer(root, root, { PATH: '' });
  const client = new LspClient({
    root,
    command: server.command,
    args: server.args,
    requestTimeoutMs: 5000,
    diagnosticsTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  const ambient = await client.navigate({ action: 'diagnostics', path: declaration });
  const moduleAmbient = await client.navigate({ action: 'diagnostics', path: moduleDeclaration });
  assert.ok(ambient.items.some(item => item.code === 1036));
  assert.ok(moduleAmbient.items.some(item => item.code === 1039));
  assert.ok(!ambient.items.some(item => item.code === 1030));
  assert.ok(!moduleAmbient.items.some(item => item.code === 1030));
});

test('LSP protocol rejects unsupported capabilities and transmits cancellation with bounded timeouts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-cancel-'));
  const source = join(root, 'sample.ts');
  const log = join(root, 'server.log');
  await writeFile(source, 'const value = 1;\n');
  const client = new LspClient({
    root,
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_LSP_LOG: log },
    requestTimeoutMs: 1000,
  });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  await client.start();
  const controller = new AbortController();
  const pending = client.navigate({ action: 'hover', path: source, line: 99, column: 1 }, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, error => error.name === 'AbortError');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok((await readLog(log)).some(event => 'cancelled' in event));

  client.capabilities.hoverProvider = false;
  await assert.rejects(client.navigate({ action: 'hover', path: source, line: 1, column: 1 }), /hover.*not supported/i);
  client.capabilities.hoverProvider = true;
  client.requestTimeoutMs = 20;
  const started = Date.now();
  await assert.rejects(client.navigate({ action: 'hover', path: source, line: 98, column: 1 }), /hover.*timed out/i);
  assert.ok(Date.now() - started < 250, 'timeout must be bounded even when the server ignores cancellation');
});

test('lazy manager reuses one client per root and expires it only after active calls finish', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-manager-'));
  const source = join(root, 'sample.ts');
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(source, 'const x = 1;');
  const clients = [];
  class FakeClient {
    constructor(options) {
      this.options = options;
      this.closed = false;
      clients.push(this);
    }
    async start() {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    async navigate(params) {
      if (params.query === 'slow') await new Promise(resolve => setTimeout(resolve, 60));
      return params.query ?? 'ok';
    }
    async close() {
      this.closed = true;
    }
  }
  const manager = new CodeNavManager({
    idleMs: 25,
    clientFactory: options => new FakeClient(options),
    resolveServer: async () => ({ command: 'fake', args: [] }),
  });
  t.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(clients.length, 0);

  assert.deepEqual(
    await Promise.all([
      manager.navigate({ action: 'symbols', path: source, query: 'one' }, root),
      manager.navigate({ action: 'symbols', path: source, query: 'two' }, root),
    ]),
    ['one', 'two'],
  );
  assert.equal(clients.length, 1);

  const slow = manager.navigate({ action: 'symbols', path: source, query: 'slow' }, root);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(clients[0].closed, false, 'an active request must prevent idle expiry');
  await slow;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(clients[0].closed, true);
  assert.equal(manager.size, 0);
});

test('lazy manager evicts a crashed stdio server and leaves no process after idle expiry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-process-'));
  const source = join(root, 'sample.ts');
  await writeFile(source, 'const x = 1;');
  const manager = new CodeNavManager({
    idleMs: 30,
    resolveServer: async () => ({ command: process.execPath, args: [fakeServer] }),
    clientOptions: { requestTimeoutMs: 500, shutdownTimeoutMs: 100 },
  });
  t.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });

  await manager.navigate({ action: 'symbols', path: source, query: 'normal' }, root);
  const firstPid = [...manager.entries.values()][0].client.child.pid;
  await manager.navigate({ action: 'symbols', path: source, query: 'x' }, root);
  assert.equal([...manager.entries.values()][0].client.child.pid, firstPid);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(manager.size, 0);
  assert.throws(() => process.kill(firstPid, 0), /ESRCH/);

  await assert.rejects(
    manager.navigate({ action: 'symbols', path: source, query: 'crash' }, root),
    /closed|exited|disposed/i,
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(manager.size, 0);
  await manager.navigate({ action: 'symbols', path: source, query: 'normal' }, root);
  assert.notEqual([...manager.entries.values()][0].client.child.pid, firstPid);
});

test('code_nav registers exactly one strict tool and validates action-specific one-based parameters', async () => {
  const fake = createFakePi();
  codeIntelligenceExtension(fake.pi);
  const registered = [...fake.tools.values()];
  assert.deepEqual(
    registered.map(tool => tool.name),
    ['code_nav'],
  );
  const schema = registered[0].parameters;
  // Mirror Pi 0.85.1's non-strict Anthropic projection.
  const anthropicInputSchema = {
    type: 'object',
    properties: schema.properties ?? {},
    required: schema.required ?? [],
  };
  assert.deepEqual(Object.keys(anthropicInputSchema.properties), [
    'action',
    'path',
    'line',
    'column',
    'query',
    'limit',
  ]);
  assert.deepEqual(anthropicInputSchema.required, ['action', 'path']);
  assert.equal(Check(schema, { action: 'symbols', path: 'src/a.ts' }), true);
  assert.equal(Check(schema, { action: 'symbols', path: 'src/a.ts', query: 'thing', limit: 10 }), true);
  assert.equal(Check(schema, { action: 'definition', path: 'src/a.ts', line: 1, column: 1 }), true);
  assert.equal(Check(schema, { action: 'references', path: 'src/a.ts', line: 0, column: 1 }), false);
  assert.equal(Check(schema, { action: 'hover', path: 'src/a.ts' }), false);
  assert.equal(Check(schema, { action: 'diagnostics', path: 'src/a.ts', line: 1 }), false);
  assert.equal(Check(schema, { action: 'diagnostics', path: 'src/a.ts', extra: true }), false);
  assert.equal(typeof fake.handlers.get('session_shutdown')?.[0], 'function');
});

test('code_nav routes each action with cancellation and returns compact one-based output', async () => {
  const calls = [];
  const manager = {
    async navigate(params, cwd, signal) {
      calls.push({ params, cwd, signal });
      if (params.action === 'symbols')
        return [
          {
            name: 'Thing',
            kind: 5,
            location: { uri: 'file:///tmp/project/a.ts', range: { start: { line: 1, character: 2 } } },
          },
        ];
      if (params.action === 'definition')
        return { uri: 'file:///tmp/project/a.ts', range: { start: { line: 2, character: 3 } } };
      if (params.action === 'references')
        return [{ uri: 'file:///tmp/project/a.ts', range: { start: { line: 3, character: 4 } } }];
      if (params.action === 'hover') return { contents: { kind: 'markdown', value: '`number`' } };
      return [{ severity: 1, source: 'ts', message: 'broken', range: { start: { line: 4, character: 5 } } }];
    },
  };
  const tool = createCodeNavTool({ manager });
  const signal = new AbortController().signal;
  const ctx = { cwd: '/tmp/project' };
  const requests = [
    { action: 'symbols', path: 'a.ts' },
    { action: 'definition', path: 'a.ts', line: 1, column: 1 },
    { action: 'references', path: 'a.ts', line: 1, column: 1 },
    { action: 'hover', path: 'a.ts', line: 1, column: 1 },
    { action: 'diagnostics', path: 'a.ts' },
  ];
  const outputs = [];
  for (const params of requests) outputs.push(await tool.execute('id', params, signal, undefined, ctx));
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.signal === signal && call.cwd === ctx.cwd));
  assert.match(outputs[0].content[0].text, /a\.ts:2:3.*Thing/);
  assert.match(outputs[1].content[0].text, /a\.ts:3:4/);
  assert.match(outputs[2].content[0].text, /a\.ts:4:5/);
  assert.match(outputs[3].content[0].text, /number/);
  assert.match(outputs[4].content[0].text, /a\.ts:5:6.*error.*broken/i);
  assert.ok(outputs.every(output => !('raw' in output.details)));
});

test('code_nav is declared by the Pi package and documented with its prerequisites', async () => {
  const { readFile } = await import('node:fs/promises');
  const workspaceJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  const packageJson = JSON.parse(
    await readFile(join(process.cwd(), 'packages/code-intelligence/package.json'), 'utf8'),
  );
  assert.ok(workspaceJson.pi.extensions.includes('./packages/code-intelligence/index.js'));
  assert.deepEqual(packageJson.pi.extensions, ['./index.js']);
  assert.equal(packageJson.dependencies['vscode-jsonrpc'], '8.2.1');
  assert.equal(packageJson.dependencies['typescript-language-server'], '6.0.0');
  assert.equal(packageJson.devDependencies?.['typescript-language-server'], undefined);
  const rootReadme = await (await import('node:fs/promises')).readFile(join(process.cwd(), 'README.md'), 'utf8');
  const extensionReadme = await (
    await import('node:fs/promises')
  ).readFile(join(process.cwd(), 'packages/code-intelligence/README.md'), 'utf8');
  assert.match(rootReadme, /code-intelligence/);
  assert.match(extensionReadme, /typescript-language-server/);
  assert.match(extensionReadme, /five minutes|cinq minutes/i);
  assert.match(extensionReadme, /symbols.*definition.*references.*hover.*diagnostics/is);
});

test('code_nav explicitly marks push diagnostics as potentially incomplete', async () => {
  const output = await formatCodeNavOutput(
    'diagnostics',
    {
      items: [],
      incomplete: true,
      reason: 'The server does not expose a completion marker for push diagnostics.',
    },
    { path: '/tmp/project/a.ts', cwd: '/tmp/project', limit: 50 },
  );
  assert.equal(output.details.incomplete, true);
  assert.match(output.content[0].text, /diagnostics may be incomplete/i);
  assert.match(output.content[0].text, /completion marker/i);
});

test('code_nav limits collections and bytes while saving complete output privately', async t => {
  const raw = Array.from({ length: 80 }, (_, index) => ({
    name: `symbol-${index}-${'x'.repeat(1000)}`,
    kind: 12,
    location: { uri: 'file:///tmp/project/a.ts', range: { start: { line: index, character: 0 } } },
  }));
  const output = await formatCodeNavOutput('symbols', raw, {
    path: '/tmp/project/a.ts',
    cwd: '/tmp/project',
    limit: 5,
  });
  t.after(() => rm(dirname(output.details.fullOutputPath), { recursive: true, force: true }));
  assert.equal(output.details.truncated, true);
  assert.equal(output.details.count, 80);
  assert.match(output.content[0].text, /symbol-0/);
  assert.doesNotMatch(output.content[0].text, /symbol-6/);
  assert.ok(Buffer.byteLength(output.content[0].text) <= 50_000);
  assert.match(output.content[0].text, /complete output from \/.*output\.txt/i);
  const saved = await (await import('node:fs/promises')).readFile(output.details.fullOutputPath, 'utf8');
  assert.match(saved, /symbol-79/);
  assert.equal((await (await import('node:fs/promises')).stat(output.details.fullOutputPath)).mode & 0o777, 0o600);
});

test('shutdown waits for a client already closing after idle eviction', { timeout: 5_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-closing-race-'));
  const source = join(root, 'sample.ts');
  await writeFile(source, 'const x = 1;');
  let releaseClose;
  let markCloseStarted;
  const closeGate = new Promise(resolve => {
    releaseClose = resolve;
  });
  const closeStarted = new Promise(resolve => {
    markCloseStarted = resolve;
  });
  const client = {
    start: async () => {},
    navigate: async () => 'ok',
    close: async () => {
      markCloseStarted();
      await closeGate;
    },
  };
  const manager = new CodeNavManager({
    idleMs: 10,
    clientFactory: () => client,
    resolveServer: async () => ({ command: 'fake', args: [] }),
  });
  t.after(async () => {
    releaseClose();
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });

  await manager.navigate({ action: 'symbols', path: source }, root);
  // The idle timer is unref'd so it never keeps Pi alive; hold the loop open until it fires.
  const keepAlive = setInterval(() => {}, 1_000);
  await closeStarted;
  clearInterval(keepAlive);
  assert.equal(manager.size, 0);
  const shutdown = manager.close();
  const outcome = await Promise.race([
    shutdown.then(() => 'closed'),
    new Promise(resolve => setTimeout(() => resolve('pending'), 20)),
  ]);
  releaseClose();
  await shutdown;
  assert.equal(outcome, 'pending', 'shutdown must await the in-progress idle close');
});

test('shutdown wins a race with root detection and cannot start a late client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-close-race-'));
  const source = join(root, 'sample.ts');
  await writeFile(source, 'const x = 1;');
  let releaseRoot;
  const rootReady = new Promise(resolve => {
    releaseRoot = resolve;
  });
  const clients = [];
  const manager = new CodeNavManager({
    findRoot: async () => {
      await rootReady;
      return root;
    },
    resolveServer: async () => ({ command: 'fake', args: [] }),
    clientFactory: () => {
      const client = {
        start: async () => {},
        close: async () => {
          client.closed = true;
        },
        closed: false,
      };
      clients.push(client);
      return client;
    },
  });
  t.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });

  const navigation = manager.navigate({ action: 'symbols', path: source }, root);
  await new Promise(resolve => setImmediate(resolve));
  await manager.close();
  releaseRoot();
  await assert.rejects(navigation, /manager is closed/i);
  assert.equal(clients.length, 0);
});

test('cancellation stops waiting for shared client initialization without breaking later cleanup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-start-cancel-'));
  const source = join(root, 'sample.ts');
  await writeFile(source, 'const x = 1;');
  let releaseStart;
  const startReady = new Promise(resolve => {
    releaseStart = resolve;
  });
  const clients = [];
  const manager = new CodeNavManager({
    resolveServer: async () => ({ command: 'fake', args: [] }),
    clientFactory: () => {
      const client = {
        start: () => startReady,
        navigate: async () => 'ok',
        close: async () => {
          client.closed = true;
        },
        closed: false,
      };
      clients.push(client);
      return client;
    },
  });
  t.after(async () => {
    releaseStart();
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });

  const controller = new AbortController();
  const navigation = manager.navigate({ action: 'symbols', path: source }, root, controller.signal);
  while (clients.length === 0) await new Promise(resolve => setImmediate(resolve));
  const started = Date.now();
  controller.abort();
  await assert.rejects(navigation, error => error.name === 'AbortError');
  assert.ok(Date.now() - started < 100, 'cancellation must not wait for initialization');
  releaseStart();
  await manager.close();
  assert.equal(clients[0].closed, true);
});

test('cancellation during server resolution cannot orphan a client after idle eviction', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-resolve-cancel-'));
  const source = join(root, 'sample.ts');
  await writeFile(source, 'const x = 1;');
  let releaseServer;
  const serverReady = new Promise(resolve => {
    releaseServer = resolve;
  });
  const clients = [];
  const manager = new CodeNavManager({
    idleMs: 10,
    resolveServer: async () => {
      await serverReady;
      return { command: 'fake', args: [] };
    },
    clientFactory: () => {
      const client = {
        start: async () => {},
        navigate: async () => 'ok',
        close: async () => {
          client.closed = true;
        },
        closed: false,
      };
      clients.push(client);
      return client;
    },
  });
  t.after(async () => {
    releaseServer();
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });

  const controller = new AbortController();
  const navigation = manager.navigate({ action: 'symbols', path: source }, root, controller.signal);
  while (manager.size === 0) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(navigation, error => error.name === 'AbortError');
  await new Promise(resolve => setTimeout(resolve, 20));
  releaseServer();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clients.length, 1);
  assert.equal(clients[0].closed, true);
  assert.equal(manager.size, 0);
});

test('lazy manager evicts crashed clients, restarts cleanly, and closes all clients on shutdown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-code-nav-crash-'));
  const source = join(root, 'sample.ts');
  await writeFile(source, 'const x = 1;');
  const clients = [];
  class FakeClient {
    constructor(options) {
      this.options = options;
      this.closed = false;
      clients.push(this);
    }
    async start() {}
    async navigate() {
      return 'ok';
    }
    async close() {
      this.closed = true;
    }
    crash() {
      this.options.onCrash(new Error('boom'), this);
    }
  }
  const manager = new CodeNavManager({
    idleMs: 10_000,
    clientFactory: options => new FakeClient(options),
    resolveServer: async () => ({ command: 'fake', args: [] }),
  });
  t.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });

  await manager.navigate({ action: 'symbols', path: source }, root);
  clients[0].crash();
  await new Promise(resolve => setImmediate(resolve));
  await manager.navigate({ action: 'symbols', path: source }, root);
  assert.equal(clients.length, 2);
  await manager.close();
  assert.equal(clients[1].closed, true);
  assert.equal(manager.size, 0);
});
