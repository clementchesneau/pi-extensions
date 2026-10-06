import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { copyPublishedPackage } from './fixtures/published-package.mjs';
import { piRuntime } from './fixtures/subagents/host-runtime.mjs';

for (const injected of [true, false]) {
  test(`native SDK loader registers a production-like extension without a local SDK (${injected ? 'explicit injection' : 'host alias'})`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'subagents sdk host '));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packageRoot = join(root, 'package');
    await copyPublishedPackage('subagents', packageRoot);
    const wrapper = join(packageRoot, 'injected.js');
    await writeFile(
      wrapper,
      `import * as sdk from ${JSON.stringify(pathToFileURL(piRuntime.entry).href)};\nimport subagents from './index.js';\nexport default pi => subagents(pi, { sdk });\n`,
    );
    const extension = injected ? wrapper : join(packageRoot, 'index.js');
    const runner = join(root, 'sdk-parent.mjs');
    await writeFile(
      runner,
      `import assert from 'node:assert/strict';
import * as sdk from ${JSON.stringify(pathToFileURL(piRuntime.entry).href)};
// This process is an SDK embedding, not a Pi CLI. No ancestor supplies peers.
await assert.rejects(import('@earendil-works/pi-coding-agent'), { code: 'ERR_MODULE_NOT_FOUND' });
await assert.rejects(import('@earendil-works/pi-tui'), { code: 'ERR_MODULE_NOT_FOUND' });
await assert.rejects(import('typebox'), { code: 'ERR_MODULE_NOT_FOUND' });
const services = await sdk.createAgentSessionServices({
  cwd: ${JSON.stringify(root)}, agentDir: ${JSON.stringify(join(root, 'agent'))},
  settingsManager: sdk.SettingsManager.inMemory({}),
  resourceLoaderOptions: { additionalExtensionPaths: [${JSON.stringify(extension)}], noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true },
});
assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
assert.equal(services.resourceLoader.getExtensions().extensions.length, 1);
services.modelRuntime.registerProvider('sdk-host-test', {
  name: 'Local SDK registration test', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'local-only', api: 'openai-completions',
  models: [{ id: 'local', name: 'Local', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1024, maxTokens: 128 }],
});
const { session } = await sdk.createAgentSessionFromServices({
  services, sessionManager: sdk.SessionManager.inMemory(${JSON.stringify(root)}),
  model: services.modelRuntime.getModel('sdk-host-test', 'local'), thinkingLevel: 'off', noTools: true,
});
try {
  assert.deepEqual(session.getAllTools().map(tool => tool.name).filter(name => name.startsWith('subagent_')).sort(),
    ['subagent_list', 'subagent_models', 'subagent_result', 'subagent_send', 'subagent_start', 'subagent_stop', 'subagent_wait']);
} finally { await session.dispose(); }
console.log('seven-tools-without-local-sdk');
`,
    );
    const result = spawnSync(process.execPath, [runner], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, HOME: join(root, 'home'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'seven-tools-without-local-sdk');
  });
}
