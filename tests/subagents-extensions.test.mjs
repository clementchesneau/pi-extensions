import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { captureOperationalSettings } from '../packages/subagents/capabilities.js';
import { piRuntime } from './fixtures/subagents/host-runtime.mjs';
import { createSubagentRuntime } from '../packages/subagents/runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const providerPath = join(here, 'fixtures/subagents/deterministic-provider.js');
const webFakesPath = join(here, 'fixtures/subagents/web-fakes.js');
const codeNavPath = join(here, '../packages/code-intelligence/index.js');
const browserPath = join(here, '../packages/ui-check/index.js');

async function scriptedProvider() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const last = body.messages.at(-1);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finishReason, usage) =>
      response.write(
        `data: ${JSON.stringify({
          id: `script-${requests.length}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deterministic',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
      );
    const user = [...body.messages].reverse().find(message => message.role === 'user');
    const text =
      typeof user?.content === 'string'
        ? user.content
        : (user?.content ?? [])
            .filter(item => item.type === 'text')
            .map(item => item.text)
            .join('');
    const match = /CALL\s+([a-z0-9_]+)\s+(\{[^\n]*\})/iu.exec(text);
    if (last?.role !== 'tool' && match) {
      send(
        {
          role: 'assistant',
          tool_calls: [
            { index: 0, id: `call-${requests.length}`, type: 'function', function: { name: match[1], arguments: '' } },
          ],
        },
        null,
      );
      send({ tool_calls: [{ index: 0, function: { arguments: match[2] } }] }, 'tool_calls');
    } else {
      const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      send({ role: 'assistant', content }, 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, url: `http://127.0.0.1:${server.address().port}/v1` };
}

async function snapshotFor({ cwd, agentDir, extensionPaths, toolNames, providerUrl, modelId = 'deterministic' }) {
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: {
      additionalExtensionPaths: extensionPaths,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    },
  });
  services.modelRuntime.registerProvider('subagent-test', {
    name: 'Subagent deterministic test provider',
    baseUrl: providerUrl,
    apiKey: 'local-test-key',
    api: 'openai-completions',
    models: ['deterministic', 'deterministic-image'].map(id => ({
      id,
      name: id === 'deterministic' ? 'Deterministic' : 'Deterministic image',
      reasoning: false,
      input: id === 'deterministic-image' ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_384,
      maxTokens: 1_024,
    })),
  });
  const model = services.modelRuntime.getModel('subagent-test', modelId);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    model,
    thinkingLevel: 'off',
    tools: toolNames,
  });
  const byName = new Map(session.getAllTools().map(tool => [tool.name, tool]));
  const tools = toolNames.map(name => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Fixture tool ${name} was not loaded`);
    return JSON.parse(JSON.stringify(tool));
  });
  session.dispose();
  return {
    version: 1,
    parentSessionId: 'parent',
    cwd,
    agentDir,
    projectTrusted: false,
    model: {
      provider: model.provider,
      id: model.id,
      api: model.api,
      baseUrl: providerUrl,
      reasoning: model.reasoning,
      input: model.input,
    },
    thinkingLevel: 'off',
    tools,
    extensionPaths: [providerPath, ...extensionPaths],
    prompt: { contextFiles: [], skills: [] },
    settings: captureOperationalSettings(settingsManager),
  };
}

function runtimeFor(snapshot, providerUrl, suffix) {
  return createSubagentRuntime(
    {
      version: 1,
      piRuntime,
      instanceId: `${suffix}-${Date.now()}-${Math.random()}`,
      parentSessionId: 'parent',
      cwd: snapshot.cwd,
      agentDir: snapshot.agentDir,
      model: { provider: snapshot.model.provider, id: snapshot.model.id },
      thinkingLevel: 'off',
      allowedTools: snapshot.tools.map(tool => tool.name),
      resources: { extensionPaths: [], skillPaths: [], promptTemplatePaths: [], contextFiles: false },
      capabilitySnapshot: snapshot,
    },
    {
      env: { SUBAGENT_TEST_PROVIDER_URL: providerUrl, BRAVE_API_KEY: '', CONTEXT7_API_KEY: '', PI_OFFLINE: '1' },
      startupTimeoutMs: 15_000,
    },
  );
}

async function call(runtime, tool, input) {
  const run = await runtime.prompt(`CALL ${tool} ${JSON.stringify(input)}`);
  return run.result;
}

test('workers execute injected web boundaries without consuming real Brave or Context7 credentials', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'subagent-web-worker-'));
  const provider = await scriptedProvider();
  const snapshot = await snapshotFor({
    cwd,
    agentDir: cwd,
    extensionPaths: [webFakesPath],
    toolNames: ['web_search', 'web_fetch', 'context7_resolve', 'context7_docs'],
    providerUrl: provider.url,
  });
  const runtime = runtimeFor(snapshot, provider.url, 'web');
  t.after(async () => {
    await runtime.stop().catch(() => {});
    provider.server.closeAllConnections();
    await new Promise(resolve => provider.server.close(resolve));
    await rm(cwd, { recursive: true, force: true });
  });
  await runtime.start();
  assert.match((await call(runtime, 'web_search', { query: 'fixture' })).text, /fake Brave|Fixture/i);
  assert.match((await call(runtime, 'web_fetch', { url: 'https://example.test/' })).text, /Fixture page/);
  assert.match(
    (await call(runtime, 'context7_resolve', { libraryName: 'fixture', query: 'question' })).text,
    /fixture\/library/,
  );
  assert.match(
    (await call(runtime, 'context7_docs', { libraryId: '/fixture/library', query: 'question' })).text,
    /documented/,
  );
});

test('workers share project files while a real code_nav server remains worker-local', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'subagent-lsp-worker-'));
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  const provider = await scriptedProvider();
  const snapshot = await snapshotFor({
    cwd,
    agentDir: cwd,
    extensionPaths: [codeNavPath],
    toolNames: ['write', 'code_nav'],
    providerUrl: provider.url,
  });
  const runtime = runtimeFor(snapshot, provider.url, 'lsp');
  t.after(async () => {
    await runtime.stop().catch(() => {});
    provider.server.closeAllConnections();
    await new Promise(resolve => provider.server.close(resolve));
    await rm(cwd, { recursive: true, force: true });
  });
  await runtime.start();
  assert.match(
    (await call(runtime, 'write', { path: 'shared.ts', content: 'export const sharedValue = 42;\n' })).text,
    /Successfully wrote|Wrote/i,
  );
  assert.equal(await readFile(join(cwd, 'shared.ts'), 'utf8'), 'export const sharedValue = 42;\n');
  assert.match((await call(runtime, 'code_nav', { action: 'symbols', path: 'shared.ts' })).text, /sharedValue/);
});

test('two real browser workers keep cookies independent and stopping one leaves the other usable', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'subagent-browser-worker-'));
  const provider = await scriptedProvider();
  const app = createServer((request, response) => {
    const set = /^\/set\/(a|b)$/u.exec(request.url ?? '');
    response.setHeader('content-type', 'text/html');
    if (set) {
      response.setHeader('set-cookie', `owner=${set[1]}; Path=/`);
      response.end(`<h1>set ${set[1]}</h1>`);
      return;
    }
    response.end(`<h1>owner ${request.headers.cookie ?? 'none'}</h1>`);
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const appUrl = `http://127.0.0.1:${app.address().port}`;
  const textSnapshot = await snapshotFor({
    cwd,
    agentDir: cwd,
    extensionPaths: [browserPath],
    toolNames: ['browser_open', 'browser_inspect'],
    providerUrl: provider.url,
  });
  const imageSnapshot = await snapshotFor({
    cwd,
    agentDir: cwd,
    extensionPaths: [browserPath],
    toolNames: ['browser_open', 'browser_inspect'],
    providerUrl: provider.url,
    modelId: 'deterministic-image',
  });
  const first = runtimeFor(textSnapshot, provider.url, 'browser-a');
  const second = runtimeFor(imageSnapshot, provider.url, 'browser-b');
  t.after(async () => {
    await Promise.all([first.stop().catch(() => {}), second.stop().catch(() => {})]);
    provider.server.closeAllConnections();
    app.closeAllConnections();
    await new Promise(resolve => provider.server.close(resolve));
    await new Promise(resolve => app.close(resolve));
    await rm(cwd, { recursive: true, force: true });
  });
  await Promise.all([first.start(), second.start()]);
  await Promise.all([
    call(first, 'browser_open', { url: `${appUrl}/set/a` }),
    call(second, 'browser_open', { url: `${appUrl}/set/b` }),
  ]);
  assert.match((await call(first, 'browser_open', { url: `${appUrl}/who` })).text, /owner=a/);
  assert.match((await call(second, 'browser_open', { url: `${appUrl}/who` })).text, /owner=b/);
  assert.match((await call(first, 'browser_inspect', { screenshot: true })).text, /image/i);
  assert.match((await call(second, 'browser_inspect', { screenshot: true })).text, /image\/jpeg|screenshot/i);
  await first.stop();
  assert.match((await call(second, 'browser_open', { url: `${appUrl}/who` })).text, /owner=b/);
});
