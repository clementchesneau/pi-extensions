import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createBashTool,
  createReadTool,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  captureCapabilitySnapshot,
  captureOperationalSettings,
  capturePrivateCapabilityBootstrap,
  resolveExtensionLoadOrder,
  selectCapabilityTools,
} from '../packages/subagents/capabilities.js';
import {
  assertChildCapabilities,
  assertChildRequestCapabilities,
  createCapabilityGuardExtension,
  createChildResourceConfiguration,
} from '../packages/subagents/child-resources.js';
import { createFakePi } from './fixtures/fake-pi.mjs';
import { piRuntime, sdk } from './fixtures/subagents/host-runtime.mjs';
import { validateBootstrap } from '../packages/subagents/bootstrap.js';
import { createSubagentRuntime } from '../packages/subagents/runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const providerPath = join(here, 'fixtures/subagents/deterministic-provider.js');
const dynamicToolPath = join(here, 'fixtures/subagents/dynamic-tool.js');
const unauthenticatedProviderPath = join(here, 'fixtures/subagents/unauthenticated-provider.js');
const oauthProviderPath = join(here, 'fixtures/subagents/oauth-provider.js');
const codeNavPath = join(here, '../packages/code-intelligence/index.js');
const switchModelPath = join(here, 'fixtures/subagents/switch-model.js');
const changeAuthBaseUrlPath = join(here, 'fixtures/subagents/change-auth-base-url.js');

const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
const source = (path, sourceName = path) => ({ path, source: sourceName, scope: 'temporary', origin: 'top-level' });

function parentFixture(extensionPath) {
  const tools = [
    {
      name: 'read',
      description: 'overridden read',
      parameters: schema,
      promptGuidelines: ['Use read.'],
      sourceInfo: source(extensionPath),
    },
    {
      name: 'bash',
      description: 'builtin bash',
      parameters: { type: 'object' },
      sourceInfo: source('<builtin:bash>', 'builtin'),
    },
    {
      name: 'subagent_launch',
      description: 'delegate',
      parameters: {},
      sourceInfo: source('/repo/extensions/subagents/index.js'),
    },
  ];
  const { pi } = createFakePi({
    getCommands: () => [{ name: 'provider-setup', source: 'extension', sourceInfo: source(extensionPath) }],
  });
  for (const tool of tools) pi.registerTool(tool);
  return {
    pi,
    ctx: {
      cwd: '/repo',
      model: {
        provider: 'fixture',
        id: 'model-a',
        api: 'openai-completions',
        baseUrl: 'https://example.test/v1',
        reasoning: true,
        input: ['text'],
        compat: { supportsDeveloperRole: true },
        thinkingLevelMap: { high: 'high' },
      },
      thinkingLevel: 'high',
      isProjectTrusted: () => false,
    },
  };
}

test('tool selection distinguishes omitted, empty, unknown and non-reproducible tools', () => {
  const tools = [
    { name: 'read', sourceInfo: source('<builtin:read>', 'builtin') },
    { name: 'custom', sourceInfo: source('/tmp/custom.js') },
    { name: 'memory', sourceInfo: source('<sdk:memory>', 'sdk') },
    { name: 'ordinary_nested_extension', sourceInfo: source('/tmp/subagents/provider.js') },
    { name: 'coordinator_alias', sourceInfo: source('/tmp/extensions/subagents/index.js') },
    {
      name: 'installed_coordinator_alias',
      sourceInfo: source('/tmp/node_modules/@clement_chsn/pi-subagents/index.js'),
    },
    { name: 'subagent_launch', sourceInfo: source('/tmp/delegation.js') },
  ];
  assert.deepEqual(
    selectCapabilityTools(
      tools.filter(tool => tool.name !== 'memory'),
      undefined,
    ).map(tool => tool.name),
    ['read', 'custom', 'ordinary_nested_extension'],
  );
  assert.throws(() => selectCapabilityTools(tools, undefined), /not reproducible/i);
  assert.deepEqual(
    selectCapabilityTools(tools, []).map(tool => tool.name),
    [],
  );
  assert.throws(() => selectCapabilityTools(tools, ['missing']), /not active/i);
  assert.throws(() => selectCapabilityTools(tools, ['memory']), /not reproducible/i);
  assert.throws(() => selectCapabilityTools(tools, ['coordinator_alias']), /delegation|subagent/i);
  assert.throws(() => selectCapabilityTools(tools, ['installed_coordinator_alias']), /delegation|subagent/i);
  assert.throws(() => selectCapabilityTools(tools, ['subagent_launch']), /delegation|subagent/i);
});

test('snapshot rejects a reloadable tool whose source disappeared', async () => {
  const { pi, ctx } = parentFixture('/tmp/definitely-missing-subagent-extension.js');
  await assert.rejects(
    captureCapabilitySnapshot({
      pi,
      ctx,
      systemPromptOptions: { cwd: '/repo', contextFiles: [], skills: [] },
      settingsManager: SettingsManager.inMemory(),
      parentSessionId: 'parent',
      agentDir: '/agent',
      tools: ['read'],
    }),
    /Extension source is unavailable/i,
  );
});

test('skill and prompt commands are not loaded as JavaScript extensions in the worker', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-markdown-commands-'));
  const skillPath = join(agentDir, 'SKILL.md');
  const promptPath = join(agentDir, 'review.md');
  await writeFile(skillPath, '# Skill fixture');
  await writeFile(promptPath, '# Prompt fixture');
  const providerConfig = {
    name: 'Markdown command fixture',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'local-test-key',
    api: 'openai-completions',
    models: [
      {
        id: 'markdown-model',
        name: 'Markdown model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
      },
    ],
  };
  const model = {
    provider: 'markdown-fixture',
    ...providerConfig.models[0],
    api: providerConfig.api,
    baseUrl: providerConfig.baseUrl,
  };
  const snapshot = await captureCapabilitySnapshot({
    pi: createFakePi({
      getCommands: () => [
        { name: 'skill:fixture', source: 'skill', sourceInfo: source(skillPath) },
        { name: 'review', source: 'prompt', sourceInfo: source(promptPath) },
      ],
    }).pi,
    ctx: { cwd: process.cwd(), model, thinkingLevel: 'off', isProjectTrusted: () => false },
    systemPromptOptions: {
      cwd: process.cwd(),
      contextFiles: [],
      skills: [
        { name: 'fixture', description: 'Fixture skill', filePath: skillPath, baseDir: agentDir, source: 'custom' },
      ],
    },
    settingsManager: SettingsManager.inMemory(),
    parentSessionId: 'parent',
    agentDir,
    tools: [],
  });
  assert.deepEqual(snapshot.extensionPaths, []);
  assert.equal(snapshot.prompt.skills[0].filePath, skillPath);
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime,
      instanceId: `markdown-${Date.now()}`,
      parentSessionId: 'parent',
      cwd: process.cwd(),
      agentDir,
      model: { provider: model.provider, id: model.id },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: {},
      capabilitySnapshot: snapshot,
      privateCapabilities: capturePrivateCapabilityBootstrap({
        providerRegistrations: [{ id: model.provider, config: providerConfig }],
      }),
    },
    { env: { PI_OFFLINE: '1' }, startupTimeoutMs: 10_000 },
  );
  t.after(async () => {
    await runtime.stop().catch(() => {});
    await rm(agentDir, { recursive: true, force: true });
  });
  await runtime.start();
});

test('snapshot preserves explicit Pi extension priority independently of requested tool order', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subagent-extension-order-'));
  const extensionA = join(directory, 'a.js');
  const extensionB = join(directory, 'b.js');
  const tool = (name, description) =>
    `pi.registerTool({ name: '${name}', label: '${name}', description: '${description}', parameters: { type: 'object', properties: {} }, async execute() { return { content: [{ type: 'text', text: '${description}' }] }; } });`;
  await writeFile(extensionA, `export default function (pi) { ${tool('shared', 'from A')} }\n`);
  await writeFile(
    extensionB,
    `export default function (pi) { ${tool('read', 'from B')} ${tool('shared', 'from B')} }\n`,
  );
  // B is configured while A was injected through additionalExtensionPaths: Pi loads A → B.
  const settingsManager = SettingsManager.inMemory({ extensions: [extensionB] });
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir: directory,
    settingsManager,
    resourceLoaderOptions: {
      additionalExtensionPaths: [extensionA],
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(process.cwd()),
    model: undefined,
    thinkingLevel: 'off',
    tools: ['read', 'shared'],
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const allTools = session.getAllTools();
  assert.deepEqual(
    allTools.filter(item => ['read', 'shared'].includes(item.name)).map(item => item.name),
    ['read', 'shared'],
  );
  assert.equal(allTools.find(item => item.name === 'shared').description, 'from A');
  const captureInput = {
    pi: {
      getActiveTools: () => session.getActiveToolNames(),
      getAllTools: () => session.getAllTools(),
      getCommands: () => [],
    },
    ctx: {
      cwd: process.cwd(),
      model: { provider: 'fixture', id: 'model' },
      thinkingLevel: 'off',
      isProjectTrusted: () => false,
    },
    systemPromptOptions: { contextFiles: [], skills: [] },
    settingsManager,
    parentSessionId: 'parent',
    agentDir: directory,
    tools: ['read', 'shared'],
  };
  // Settings alone do not attest the order: the parent may have ignored them.
  await assert.rejects(captureCapabilitySnapshot(captureInput), /extension load order.*unavailable/i);
  await assert.rejects(
    captureCapabilitySnapshot({ ...captureInput, extensionLoadOrder: [extensionB] }),
    /extension load order.*incomplete/i,
  );
  const snapshot = await captureCapabilitySnapshot({ ...captureInput, extensionLoadOrder: [extensionA, extensionB] });
  assert.deepEqual(
    snapshot.tools.map(item => item.name),
    ['read', 'shared'],
  );
  assert.deepEqual(snapshot.extensionPaths, [await realpath(extensionA), await realpath(extensionB)]);
});

async function writePackage(directory, entries) {
  await mkdir(directory, { recursive: true });
  for (const entry of entries) await writeFile(join(directory, entry), 'export default function () {}');
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ pi: { extensions: entries.map(entry => `./${entry}`) } }),
  );
  return Promise.all(entries.map(entry => realpath(join(directory, entry))));
}

test("a CLI parent extension order matches Pi's loader, with or without --no-extensions", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'subagent-package-order-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [first, second] = await writePackage(join(directory, 'aggregate'), ['first.js', 'second.js']);
  const [web] = await writePackage(join(directory, 'web'), ['index.js']);
  const [cli] = await writePackage(join(directory, 'cli'), ['index.js']);
  const [entry] = await writePackage(join(directory, 'entry'), ['entry.js']);
  // Separately installed packages: no manifest lists both, only settings order them.
  const settingsManager = SettingsManager.inMemory({
    extensions: [entry],
    packages: [join(directory, 'web'), join(directory, 'aggregate')],
  });
  const resolveOrder = options => resolveExtensionLoadOrder({ sdk, cwd: directory, agentDir: directory, ...options });
  const argv = ['node', 'pi', '-e', join(directory, 'cli'), '--extension', 'npm:remote-never-resolved'];
  // The order Pi's own loader produces for the same command line and settings.
  const loadedOrder = async noExtensions => {
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      additionalExtensionPaths: [join(directory, 'cli')],
      noExtensions,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    return Promise.all(loader.getExtensions().extensions.map(extension => realpath(extension.resolvedPath)));
  };
  const order = await resolveOrder({ settingsManager, cli: true, argv });
  assert.deepEqual(order, await loadedOrder(false));
  assert.deepEqual(order, [cli, entry, web, first, second]);
  // --no-extensions loads only the command-line sources, whatever the settings say.
  const withoutSettings = await resolveOrder({ settingsManager, cli: true, argv: [...argv, '-ne'] });
  assert.deepEqual(withoutSettings, await loadedOrder(true));
  assert.deepEqual(withoutSettings, [cli]);

  const tools = [second, cli, first, web].map((path, index) => ({
    name: `tool${index}`,
    sourceInfo: { path, source: path, scope: 'user', origin: 'package' },
  }));
  const { ctx } = parentFixture(first);
  ctx.cwd = directory;
  const { pi } = createFakePi();
  for (const tool of tools) pi.registerTool(tool);
  const captureInput = {
    pi,
    ctx,
    systemPromptOptions: { contextFiles: [], skills: [] },
    settingsManager,
    agentDir: directory,
  };
  const snapshot = await captureCapabilitySnapshot({ ...captureInput, extensionLoadOrder: order });
  assert.deepEqual(snapshot.extensionPaths, [cli, web, first, second]);
  await assert.rejects(captureCapabilitySnapshot(captureInput), /extension load order.*unavailable/i);
  assert.deepEqual(await resolveOrder({ sdk: {}, settingsManager, cli: true, argv }), []);
});

test('an SDK parent claims no extension order, so settings it ignored cannot reorder its sources', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'subagent-sdk-order-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [first, second] = await writePackage(join(directory, 'aggregate'), ['first.js', 'second.js']);
  const tools = [first, second].map((path, index) => ({
    name: `tool${index}`,
    sourceInfo: { path, source: path, scope: 'user', origin: 'package' },
  }));
  const { ctx } = parentFixture(first);
  ctx.cwd = directory;
  const { pi } = createFakePi();
  for (const tool of tools) pi.registerTool(tool);
  // The parent loaded the aggregate (first → second) with noExtensions; these settings were ignored.
  for (const ignored of [{ packages: [second, first] }, { extensions: [second, first] }]) {
    const settingsManager = SettingsManager.inMemory(ignored);
    const order = await resolveExtensionLoadOrder({
      sdk,
      cwd: directory,
      agentDir: directory,
      settingsManager,
      cli: false,
    });
    assert.deepEqual(order, []);
    await assert.rejects(
      captureCapabilitySnapshot({
        pi,
        ctx,
        systemPromptOptions: { contextFiles: [], skills: [] },
        settingsManager,
        agentDir: directory,
        extensionLoadOrder: order,
      }),
      /extension load order.*unavailable/i,
      JSON.stringify(Object.keys(ignored)),
    );
  }
});

test('snapshot captures exact prompt, model, settings and canonical reloadable sources without conversation state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subagent-capabilities-'));
  const extensionPath = join(directory, 'extension.js');
  const skillPath = join(directory, 'SKILL.md');
  await writeFile(extensionPath, 'export default () => {};');
  await writeFile(skillPath, '# Fixture skill');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { pi, ctx } = parentFixture(extensionPath);
  ctx.modelRegistry = {
    getProviderAuth: async () => ({
      auth: { apiKey: 'must-not-be-captured', baseUrl: 'https://gateway.example.test/v1' },
    }),
    isUsingOAuth: () => false,
    getRegisteredProviderIds: () => [],
    getRegisteredProviderConfig: () => undefined,
    getRegisteredNativeProvider: () => undefined,
  };
  const settingsManager = SettingsManager.inMemory(
    {
      shellPath: '/bin/zsh',
      shellCommandPrefix: 'source fixture',
      transport: 'sse',
      steeringMode: 'all',
      followUpMode: 'all',
      compaction: { enabled: false, reserveTokens: 123, keepRecentTokens: 45 },
      retry: {
        enabled: false,
        maxRetries: 7,
        baseDelayMs: 9,
        provider: { timeoutMs: 10, maxRetries: 2, maxRetryDelayMs: 11 },
      },
      thinkingBudgets: { high: 4096 },
      images: { autoResize: false, blockImages: true },
      terminal: { showImages: false },
    },
    { projectTrusted: false },
  );
  const prompt = {
    cwd: '/repo',
    customPrompt: 'custom',
    appendSystemPrompt: 'append',
    promptGuidelines: ['guide'],
    contextFiles: [{ path: '/repo/AGENTS.md', content: 'instructions' }],
    skills: [{ name: 'fixture', description: 'skill', filePath: skillPath, baseDir: directory, source: 'custom' }],
  };
  const snapshot = await captureCapabilitySnapshot({
    pi,
    ctx,
    systemPromptOptions: prompt,
    settingsManager,
    parentSessionId: 'parent',
    agentDir: directory,
  });
  assert.equal(snapshot.version, 1);
  assert.deepEqual(
    snapshot.tools.map(tool => tool.name),
    ['read', 'bash'],
  );
  assert.deepEqual(snapshot.extensionPaths, [await realpath(extensionPath)]);
  assert.equal(snapshot.model.provider, 'fixture');
  assert.deepEqual(snapshot.model.providerImplementation, { kind: 'builtin' });
  assert.equal(snapshot.model.requestBaseUrl, 'https://gateway.example.test/v1');
  assert.equal(snapshot.model.authMode, 'configured');
  assert.doesNotMatch(JSON.stringify(snapshot), /must-not-be-captured/);
  assert.equal(snapshot.thinkingLevel, 'high');
  assert.deepEqual(snapshot.model.thinkingLevelMap, { high: 'high' });
  assert.equal(snapshot.projectTrusted, false);
  assert.equal(snapshot.prompt.contextFiles[0].content, 'instructions');
  assert.equal(snapshot.prompt.skills[0].filePath, skillPath);
  assert.equal(snapshot.settings.shellCommandPrefix, 'source fixture');
  assert.equal(snapshot.settings.steeringMode, 'all');
  assert.equal(snapshot.settings.followUpMode, 'all');
  assert.equal(snapshot.settings.compaction.enabled, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /messages|conversation|history/i);
  assert.doesNotThrow(() => structuredClone(snapshot));
});

test('persistable model metadata excludes credential-bearing provider headers', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-model-headers-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    },
  });
  const secret = 'synthetic-authorization-token';
  services.modelRuntime.registerProvider('header-fixture', {
    name: 'Header fixture',
    baseUrl: 'https://example.test/v1',
    apiKey: 'local-test-key',
    api: 'openai-completions',
    models: [
      {
        id: 'header-model',
        name: 'Header model',
        reasoning: false,
        input: ['text'],
        headers: { Authorization: `Bearer ${secret}`, 'X-Provider-Secret': secret },
        compat: { supportsDeveloperRole: true },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
      },
    ],
  });
  const registeredModel = services.modelRuntime.getModel('header-fixture', 'header-model');
  const model = { ...registeredModel, headers: { Authorization: `Bearer ${secret}`, 'X-Provider-Secret': secret } };
  assert.equal(model.headers.Authorization, `Bearer ${secret}`);
  const snapshot = await captureCapabilitySnapshot({
    pi: createFakePi().pi,
    ctx: {
      cwd: process.cwd(),
      model,
      modelRegistry: new ModelRegistry(services.modelRuntime),
      thinkingLevel: 'off',
      isProjectTrusted: () => false,
    },
    systemPromptOptions: { cwd: process.cwd(), contextFiles: [], skills: [] },
    settingsManager: services.settingsManager,
    parentSessionId: 'parent',
    agentDir,
    tools: [],
  });
  assert.equal(snapshot.model.headers, undefined);
  assert.deepEqual(snapshot.model.compat, { supportsDeveloperRole: true });
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
});

test('capture rejects a function-based provider override that exists only in parent memory', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-memory-provider-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    },
  });
  services.modelRuntime.registerProvider('openai', {
    api: 'openai-completions',
    streamSimple() {
      throw new Error('parent-only stream implementation');
    },
  });
  await services.modelRuntime.setRuntimeApiKey('openai', 'fixture-key');
  const model = services.modelRuntime.getModel('openai', 'gpt-4');
  assert.ok(model, 'Pi must expose the built-in openai/gpt-4 fixture model');
  const modelRegistry = new ModelRegistry(services.modelRuntime);
  await assert.rejects(
    captureCapabilitySnapshot({
      pi: createFakePi().pi,
      ctx: { cwd: process.cwd(), model, modelRegistry, thinkingLevel: 'off', isProjectTrusted: () => false },
      systemPromptOptions: { cwd: process.cwd(), contextFiles: [], skills: [] },
      settingsManager: services.settingsManager,
      parentSessionId: 'parent',
      agentDir,
      tools: [],
    }),
    /provider.*not reproducible|memory-only provider/i,
  );
});

test('capture accepts a function-based provider only with an explicit reloadable source', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-sourced-provider-'));
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({
      'subagent-oauth': {
        type: 'oauth',
        access: 'simulated-access',
        refresh: 'simulated-refresh',
        expires: Date.now() + 3_600_000,
      },
    }),
    { mode: 0o600 },
  );
  const settingsManager = SettingsManager.inMemory();
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
    resourceLoaderOptions: {
      additionalExtensionPaths: [oauthProviderPath],
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    },
  });
  const model = services.modelRuntime.getModel('subagent-oauth', 'oauth-model');
  const snapshot = await captureCapabilitySnapshot({
    pi: createFakePi().pi,
    ctx: {
      cwd: process.cwd(),
      model,
      modelRegistry: new ModelRegistry(services.modelRuntime),
      thinkingLevel: 'off',
      isProjectTrusted: () => false,
    },
    systemPromptOptions: { cwd: process.cwd(), contextFiles: [], skills: [] },
    settingsManager,
    parentSessionId: 'parent',
    agentDir,
    tools: [],
    providerSourcePaths: { 'subagent-oauth': oauthProviderPath },
  });
  assert.deepEqual(snapshot.model.providerImplementation, {
    kind: 'extension',
    path: await realpath(oauthProviderPath),
  });
  assert.deepEqual(snapshot.extensionPaths, [await realpath(oauthProviderPath)]);
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime,
      instanceId: `sourced-provider-${Date.now()}`,
      parentSessionId: 'parent',
      cwd: process.cwd(),
      agentDir,
      model: { provider: model.provider, id: model.id },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: {},
      capabilitySnapshot: snapshot,
    },
    { env: { PI_OFFLINE: '1' }, startupTimeoutMs: 10_000 },
  );
  t.after(async () => {
    await runtime.stop().catch(() => {});
    await rm(agentDir, { recursive: true, force: true });
  });
  await runtime.start();
});

test('private model overrides stay outside persistable capability snapshots', () => {
  const secret = 'fixture-secret-that-must-not-be-metadata';
  const privateBootstrap = capturePrivateCapabilityBootstrap({ runtimeApiKeys: { fixture: secret } });
  assert.equal(privateBootstrap.runtimeApiKeys.fixture, secret);
  const bootstrap = {
    version: 1,
    piRuntime,
    instanceId: 'private',
    cwd: '/repo',
    agentDir: '/agent',
    model: { provider: 'fixture', id: 'model' },
    thinkingLevel: 'off',
    allowedTools: [],
    resources: {},
    capabilitySnapshot: {
      version: 1,
      cwd: '/repo',
      agentDir: '/agent',
      model: { provider: 'fixture', id: 'model' },
      thinkingLevel: 'off',
      tools: [],
      extensionPaths: [],
      runtimeApiKeys: { fixture: secret },
    },
  };
  assert.throws(() => validateBootstrap(bootstrap), /must not be stored/i);
});

test('operational settings are copied through public getters only', () => {
  const settings = SettingsManager.inMemory({
    shellPath: '/bin/bash',
    shellCommandPrefix: 'fixture',
    transport: 'websocket',
    steeringMode: 'all',
    followUpMode: 'all',
    images: { blockImages: true },
  });
  assert.deepEqual(captureOperationalSettings(settings), {
    shellPath: '/bin/bash',
    shellCommandPrefix: 'fixture',
    transport: 'websocket',
    steeringMode: 'all',
    followUpMode: 'all',
    compaction: settings.getCompactionSettings(),
    retry: settings.getRetrySettings(),
    providerRetry: settings.getProviderRetrySettings(),
    httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(),
    websocketConnectTimeoutMs: settings.getWebSocketConnectTimeoutMs(),
    thinkingBudgets: settings.getThinkingBudgets(),
    imageAutoResize: settings.getImageAutoResize(),
    blockImages: true,
    showImages: settings.getShowImages(),
  });
});

test('capability guard blocks a same-name tool whose provenance changes after bootstrap', async () => {
  const expected = {
    name: 'read',
    description: 'expected',
    parameters: schema,
    sourceInfo: source('/tmp/expected.js'),
  };
  let active = ['read', 'write'];
  let actual = structuredClone(expected);
  const fake = createFakePi({
    getActiveTools: () => active,
    setActiveTools: names => {
      active = names;
    },
    getAllTools: () => [actual],
  });
  createCapabilityGuardExtension([expected]).factory(fake.pi);
  const toolCall = async toolName => (await fake.fire('tool_call', { toolName }))[0];
  await fake.fire('session_start');
  assert.deepEqual(active, ['read']);
  assert.equal(await toolCall('read'), undefined);
  actual = { ...actual, sourceInfo: source('/tmp/replacement.js') };
  assert.match((await toolCall('read')).reason, /changed schema or provenance/i);
  assert.match((await toolCall('write')).reason, /outside/i);
});

test('child resource configuration disables discovery and restores captured resources and trust', () => {
  const snapshot = {
    projectTrusted: false,
    settings: {
      shellPath: '/bin/zsh',
      shellCommandPrefix: 'fixture',
      transport: 'sse',
      steeringMode: 'all',
      followUpMode: 'all',
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 20 },
      retry: { enabled: false, maxRetries: 3, baseDelayMs: 10 },
      providerRetry: { timeoutMs: 20, maxRetries: 1, maxRetryDelayMs: 30 },
      httpIdleTimeoutMs: 40,
      thinkingBudgets: { high: 1234 },
      imageAutoResize: false,
      blockImages: true,
      showImages: false,
    },
    extensionPaths: ['/tmp/fixture.js'],
    prompt: {
      customPrompt: 'custom',
      appendSystemPrompt: 'append',
      promptGuidelines: ['captured guideline'],
      contextFiles: [{ path: '/tmp/AGENTS.md', content: 'rules' }],
      skills: [{ name: 's', filePath: '/tmp/SKILL.md', baseDir: '/tmp', description: 'd', source: 'custom' }],
    },
  };
  const { settingsManager, resourceLoaderOptions } = createChildResourceConfiguration(snapshot, { sdk });
  assert.equal(settingsManager.isProjectTrusted(), false);
  assert.equal(settingsManager.getShellCommandPrefix(), 'fixture');
  assert.equal(settingsManager.getCompactionEnabled(), false);
  assert.equal(settingsManager.getSteeringMode(), 'all');
  assert.equal(settingsManager.getFollowUpMode(), 'all');
  assert.deepEqual(settingsManager.getPackages(), []);
  assert.deepEqual(resourceLoaderOptions.additionalExtensionPaths, ['/tmp/fixture.js']);
  for (const flag of ['noExtensions', 'noSkills', 'noContextFiles', 'noPromptTemplates', 'noThemes'])
    assert.equal(resourceLoaderOptions[flag], true);
  assert.deepEqual(
    resourceLoaderOptions.agentsFilesOverride({ agentsFiles: [] }).agentsFiles,
    snapshot.prompt.contextFiles,
  );
  assert.deepEqual(
    resourceLoaderOptions.skillsOverride({ skills: [], diagnostics: [] }).skills,
    snapshot.prompt.skills,
  );
  assert.doesNotMatch(resourceLoaderOptions.appendSystemPromptOverride([]).join('\n'), /captured guideline/);
  assert.match(resourceLoaderOptions.appendSystemPromptOverride([]).join('\n'), /must not delegate/i);
});

test('a user-configured extension keeps its file identity when the worker reloads it as temporary', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-configured-extension-'));
  const settingsManager = SettingsManager.inMemory({ extensions: [codeNavPath] }, { projectTrusted: false });
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
    resourceLoaderOptions: { noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true },
  });
  const providerConfig = {
    name: 'Configured extension fixture',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'local-test-key',
    api: 'openai-completions',
    models: [
      {
        id: 'configured-model',
        name: 'Configured model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
      },
    ],
  };
  services.modelRuntime.registerProvider('configured-fixture', providerConfig);
  const model = services.modelRuntime.getModel('configured-fixture', 'configured-model');
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(process.cwd()),
    model,
    thinkingLevel: 'off',
    tools: ['code_nav'],
  });
  const parentTool = session.getAllTools().find(tool => tool.name === 'code_nav');
  assert.equal(parentTool.sourceInfo.scope, 'user');
  const snapshot = await captureCapabilitySnapshot({
    pi: {
      getActiveTools: () => session.getActiveToolNames(),
      getAllTools: () => session.getAllTools(),
      getCommands: () => [],
    },
    ctx: { cwd: process.cwd(), model, thinkingLevel: 'off', isProjectTrusted: () => false },
    systemPromptOptions: { cwd: process.cwd(), contextFiles: [], skills: [] },
    settingsManager,
    parentSessionId: 'parent',
    agentDir,
  });
  session.dispose();
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime,
      instanceId: `configured-${Date.now()}`,
      parentSessionId: 'parent',
      cwd: process.cwd(),
      agentDir,
      model: { provider: model.provider, id: model.id },
      thinkingLevel: 'off',
      allowedTools: ['code_nav'],
      resources: {},
      capabilitySnapshot: snapshot,
      privateCapabilities: capturePrivateCapabilityBootstrap({
        providerRegistrations: [{ id: 'configured-fixture', config: providerConfig }],
      }),
    },
    { env: { PI_OFFLINE: '1' }, startupTimeoutMs: 10_000 },
  );
  t.after(async () => {
    await runtime.stop().catch(() => {});
    await rm(agentDir, { recursive: true, force: true });
  });
  await runtime.start();
});

test('the worker blocks a model change before any provider request', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-fixed-model-'));
  const requestedModels = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requestedModels.push(JSON.parse(body).model);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      `data: ${JSON.stringify({ id: 'fixed-model', object: 'chat.completion.chunk', created: 1, model: 'deterministic', choices: [{ index: 0, delta: { role: 'assistant', content: 'fixed-model-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const snapshot = {
    version: 1,
    parentSessionId: 'parent',
    cwd: process.cwd(),
    agentDir,
    projectTrusted: false,
    model: {
      provider: 'subagent-test',
      id: 'deterministic',
      api: 'openai-completions',
      baseUrl: url,
      reasoning: false,
      input: ['text'],
    },
    thinkingLevel: 'off',
    tools: [],
    extensionPaths: [providerPath, switchModelPath],
    prompt: { contextFiles: [], skills: [] },
    settings: captureOperationalSettings(SettingsManager.inMemory()),
  };
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime,
      instanceId: `fixed-model-${Date.now()}`,
      parentSessionId: 'parent',
      cwd: process.cwd(),
      agentDir,
      model: { provider: 'subagent-test', id: 'deterministic' },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: {},
      capabilitySnapshot: snapshot,
    },
    { env: { SUBAGENT_TEST_PROVIDER_URL: url, PI_OFFLINE: '1' }, startupTimeoutMs: 10_000 },
  );
  t.after(async () => {
    await runtime.stop().catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(agentDir, { recursive: true, force: true });
  });
  await runtime.start();
  const run = await runtime.prompt('keep the captured model');
  const result = await run.result;
  assert.equal(result.status, 'failed');
  assert.match(result.errorMessage, /model.*changed|captured model/i);
  assert.deepEqual(requestedModels, []);
});

test('the worker blocks an authentication endpoint change before any provider request', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-auth-endpoint-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url);
    response.writeHead(500).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const snapshot = {
    version: 1,
    parentSessionId: 'parent',
    cwd: process.cwd(),
    agentDir,
    projectTrusted: false,
    model: {
      provider: 'subagent-test',
      id: 'deterministic',
      api: 'openai-completions',
      baseUrl: url,
      requestBaseUrl: url,
      reasoning: false,
      input: ['text'],
    },
    thinkingLevel: 'off',
    tools: [],
    extensionPaths: [providerPath, changeAuthBaseUrlPath],
    prompt: { contextFiles: [], skills: [] },
    settings: captureOperationalSettings(SettingsManager.inMemory()),
  };
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime,
      instanceId: `auth-endpoint-${Date.now()}`,
      parentSessionId: 'parent',
      cwd: process.cwd(),
      agentDir,
      model: { provider: 'subagent-test', id: 'deterministic' },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: {},
      capabilitySnapshot: snapshot,
    },
    {
      env: {
        SUBAGENT_TEST_PROVIDER_URL: url,
        SUBAGENT_CHANGED_AUTH_BASE_URL: 'https://changed.example.test/v1',
        PI_OFFLINE: '1',
      },
      startupTimeoutMs: 10_000,
    },
  );
  t.after(async () => {
    await runtime.stop().catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(agentDir, { recursive: true, force: true });
  });
  await runtime.start();
  const run = await runtime.prompt('reject changed endpoint');
  const result = await run.result;
  assert.equal(result.status, 'failed');
  assert.match(result.errorMessage, /effective baseUrl/i);
  assert.deepEqual(requests, []);
});

test('capability bootstrap reproduces selected prompt resources and keeps the SDK allowlist as a durable ceiling in a real worker', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-capability-worker-'));
  const skillPath = join(agentDir, 'CAPTURED-SKILL.md');
  await writeFile(skillPath, '# Captured skill\nUse the fixture shell prefix.\n');
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const chunk = (delta, finishReason, usage) =>
      `data: ${JSON.stringify({ id: 'capability', object: 'chat.completion.chunk', created: 1, model: 'deterministic', choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests.length === 1) {
      response.write(
        chunk(
          {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'call-prefix', type: 'function', function: { name: 'bash', arguments: '' } }],
          },
          null,
        ),
      );
      response.write(
        chunk(
          { tool_calls: [{ index: 0, function: { arguments: '{"command":"printf command-output"}' } }] },
          'tool_calls',
        ),
      );
    } else {
      response.write(
        chunk({ role: 'assistant', content: 'ok' }, 'stop', {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        }),
      );
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const read = createReadTool(process.cwd());
  const readCapability = {
    name: read.name,
    description: read.description,
    parameters: read.parameters,
    promptGuidelines: ['Use read to examine files instead of cat or sed.'],
    sourceInfo: source('builtin:read', 'builtin'),
  };
  const bash = createBashTool(process.cwd());
  const bashCapability = {
    name: bash.name,
    description: bash.description,
    parameters: bash.parameters,
    promptGuidelines: bash.promptGuidelines,
    sourceInfo: source('builtin:bash', 'builtin'),
  };
  const snapshot = {
    version: 1,
    parentSessionId: 'parent',
    cwd: process.cwd(),
    agentDir,
    projectTrusted: false,
    model: {
      provider: 'subagent-test',
      id: 'deterministic',
      api: 'openai-completions',
      baseUrl: url,
      reasoning: false,
      input: ['text'],
    },
    thinkingLevel: 'off',
    tools: [readCapability, bashCapability],
    extensionPaths: [providerPath, dynamicToolPath],
    prompt: {
      customPrompt: 'captured custom prompt',
      appendSystemPrompt: 'captured append',
      promptGuidelines: ['captured prompt guideline'],
      contextFiles: [{ path: join(agentDir, 'AGENTS.md'), content: 'captured parent instructions' }],
      skills: [
        {
          name: 'captured-skill',
          description: 'captured skill',
          filePath: skillPath,
          baseDir: agentDir,
          source: 'custom',
        },
      ],
    },
    settings: captureOperationalSettings(
      SettingsManager.inMemory(
        { shellCommandPrefix: 'printf captured-shell-prefix', steeringMode: 'all', followUpMode: 'all' },
        { projectTrusted: false },
      ),
    ),
  };
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime,
      instanceId: `capabilities-${Date.now()}`,
      parentSessionId: 'parent',
      cwd: process.cwd(),
      agentDir,
      model: { provider: 'subagent-test', id: 'deterministic' },
      thinkingLevel: 'off',
      allowedTools: ['read', 'bash'],
      resources: { extensionPaths: [], skillPaths: [], promptTemplatePaths: [], contextFiles: false },
      capabilitySnapshot: snapshot,
    },
    { env: { SUBAGENT_TEST_PROVIDER_URL: url, PI_OFFLINE: '1' }, startupTimeoutMs: 10_000 },
  );
  t.after(async () => {
    await runtime.stop().catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(agentDir, { recursive: true, force: true });
  });
  await runtime.start().catch(error => {
    throw new Error(`${error.message}\n${runtime.stderr}`, { cause: error });
  });
  const run = await runtime.prompt('confirm capability bootstrap');
  assert.equal((await run.result).text, 'ok');
  assert.deepEqual(
    requests[0].tools.map(tool => tool.function?.name ?? tool.name),
    ['read', 'bash'],
  );
  const requestText = JSON.stringify(requests);
  for (const captured of [
    'captured custom prompt',
    'captured append',
    'captured parent instructions',
    'captured-skill',
    'captured-shell-prefix',
    'command-output',
  ]) {
    assert.match(requestText, new RegExp(captured));
  }
  assert.match(requestText, /confirm capability bootstrap/);
  assert.doesNotMatch(requestText, /captured prompt guideline/);
  assert.doesNotMatch(requestText, /PARENT_HISTORY_SENTINEL/);
});

test('worker accepts Pi-resolved ambient authentication without API keys or headers', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-ambient-auth-'));
  const snapshot = {
    version: 1,
    cwd: process.cwd(),
    agentDir,
    projectTrusted: false,
    model: { provider: 'amazon-bedrock', id: 'amazon.nova-2-lite-v1:0', authMode: 'configured' },
    thinkingLevel: 'off',
    tools: [],
    extensionPaths: [],
    prompt: { contextFiles: [], skills: [] },
    settings: captureOperationalSettings(SettingsManager.inMemory()),
  };
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime,
      instanceId: `ambient-auth-${Date.now()}`,
      cwd: process.cwd(),
      agentDir,
      model: { provider: snapshot.model.provider, id: snapshot.model.id },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: {},
      capabilitySnapshot: snapshot,
    },
    { env: { AWS_BEARER_TOKEN_BEDROCK: 'synthetic-ambient-token', PI_OFFLINE: '1' }, startupTimeoutMs: 10_000 },
  );
  t.after(async () => {
    await runtime.stop().catch(() => {});
    await rm(agentDir, { recursive: true, force: true });
  });
  await runtime.start();
});

test('worker rejects missing authentication and an unsupported explicit thinking level before a mission', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-model-rejection-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const settings = captureOperationalSettings(SettingsManager.inMemory());
  const unauthSnapshot = {
    version: 1,
    cwd: process.cwd(),
    agentDir,
    projectTrusted: false,
    model: { provider: 'subagent-unauthenticated', id: 'missing-auth', reasoning: false, input: ['text'] },
    thinkingLevel: 'off',
    tools: [],
    extensionPaths: [unauthenticatedProviderPath],
    prompt: { contextFiles: [], skills: [] },
    settings,
  };
  const bootstrap = snapshot => ({
    version: 1,
    piRuntime,
    instanceId: `reject-${Math.random()}`,
    cwd: process.cwd(),
    agentDir,
    model: { provider: snapshot.model.provider, id: snapshot.model.id },
    thinkingLevel: snapshot.thinkingLevel,
    allowedTools: [],
    resources: { extensionPaths: [], skillPaths: [], promptTemplatePaths: [], contextFiles: false },
    capabilitySnapshot: snapshot,
  });
  const missingAuth = createSubagentRuntime(bootstrap(unauthSnapshot), {
    env: { SUBAGENT_INTENTIONALLY_MISSING_KEY: '', PI_OFFLINE: '1' },
    startupTimeoutMs: 5_000,
  });
  await assert.rejects(missingAuth.start(), /auth/i);

  const reasoningSnapshot = {
    ...unauthSnapshot,
    model: { provider: 'subagent-test', id: 'deterministic', reasoning: false, input: ['text'] },
    thinkingLevel: 'high',
    extensionPaths: [providerPath],
  };
  const unsupported = createSubagentRuntime(bootstrap(reasoningSnapshot), {
    env: { SUBAGENT_TEST_PROVIDER_URL: 'http://127.0.0.1:1/v1', PI_OFFLINE: '1' },
    startupTimeoutMs: 5_000,
  });
  await assert.rejects(unsupported.start(), /thinking level/i);

  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({
      'subagent-oauth': {
        type: 'oauth',
        access: 'simulated-access',
        refresh: 'simulated-refresh',
        expires: Date.now() + 3_600_000,
      },
    }),
    { mode: 0o600 },
  );
  const oauthSnapshot = {
    ...unauthSnapshot,
    model: { provider: 'subagent-oauth', id: 'oauth-model', reasoning: false, input: ['text'] },
    extensionPaths: [oauthProviderPath],
  };
  const oauthOverride = createSubagentRuntime(
    {
      ...bootstrap(oauthSnapshot),
      privateCapabilities: capturePrivateCapabilityBootstrap({
        runtimeApiKeys: { 'subagent-oauth': 'must-not-replace-oauth' },
      }),
    },
    { env: { PI_OFFLINE: '1' }, startupTimeoutMs: 5_000 },
  );
  await assert.rejects(oauthOverride.start(), /incompatible with OAuth\/subscription/i);
});

test('worker replays a declarative provider and private API override without putting the secret in capability metadata', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-declarative-provider-'));
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request body.
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      `data: ${JSON.stringify({ id: 'declarative', object: 'chat.completion.chunk', created: 1, model: 'declarative-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'declarative-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const secret = 'private-runtime-key';
  const snapshot = {
    version: 1,
    cwd: process.cwd(),
    agentDir,
    projectTrusted: false,
    model: {
      provider: 'declarative-fixture',
      id: 'declarative-model',
      api: 'openai-completions',
      baseUrl: url,
      reasoning: false,
      input: ['text'],
    },
    thinkingLevel: 'off',
    tools: [],
    extensionPaths: [],
    prompt: { contextFiles: [], skills: [] },
    settings: captureOperationalSettings(SettingsManager.inMemory()),
  };
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime,
      instanceId: `declarative-${Date.now()}`,
      cwd: process.cwd(),
      agentDir,
      model: { provider: 'declarative-fixture', id: 'declarative-model' },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: {},
      capabilitySnapshot: snapshot,
      privateCapabilities: capturePrivateCapabilityBootstrap({
        runtimeApiKeys: { 'declarative-fixture': secret },
        providerRegistrations: [
          {
            id: 'declarative-fixture',
            config: {
              name: 'Declarative fixture',
              baseUrl: url,
              apiKey: '$DECLARATIVE_FIXTURE_KEY',
              api: 'openai-completions',
              models: [
                {
                  id: 'declarative-model',
                  name: 'Declarative',
                  reasoning: false,
                  input: ['text'],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 4096,
                  maxTokens: 256,
                },
              ],
            },
          },
        ],
      }),
    },
    { env: { DECLARATIVE_FIXTURE_KEY: '', PI_OFFLINE: '1' }, startupTimeoutMs: 10_000 },
  );
  t.after(async () => {
    await runtime.stop().catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(agentDir, { recursive: true, force: true });
  });
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
  await runtime.start();
  const run = await runtime.prompt('use declarative provider');
  assert.equal((await run.result).text, 'declarative-ok');
  assert.doesNotMatch(runtime.stderr, new RegExp(secret));
});

test('request capability verification accepts only the captured authentication base URL override', () => {
  const snapshot = {
    model: {
      provider: 'fixture',
      id: 'model-a',
      api: 'openai-completions',
      baseUrl: 'https://configured.example/v1',
      requestBaseUrl: 'https://authenticated.example/v1',
      reasoning: false,
      input: ['text'],
    },
    thinkingLevel: 'off',
    tools: [],
  };
  const session = {
    model: { ...snapshot.model, baseUrl: snapshot.model.requestBaseUrl },
    thinkingLevel: 'off',
    getActiveToolNames: () => [],
    getAllTools: () => [],
  };
  assert.doesNotThrow(() => assertChildRequestCapabilities(session, snapshot));
  session.model.baseUrl = 'https://unexpected.example/v1';
  assert.throws(() => assertChildRequestCapabilities(session, snapshot), /model.*incompatible/i);
});

test('child capability verification compares exact model, reasoning, active tool schema and provenance', () => {
  const expectedTool = {
    name: 'read',
    description: 'overridden read',
    parameters: schema,
    promptGuidelines: ['Use read.'],
    sourceInfo: source('/tmp/extension.js'),
  };
  const snapshot = {
    model: {
      provider: 'fixture',
      id: 'model-a',
      api: 'openai-completions',
      baseUrl: 'https://example.test/v1',
      reasoning: true,
      input: ['text'],
      compat: { supportsDeveloperRole: true },
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      contextWindow: 4096,
      maxTokens: 256,
      thinkingLevelMap: { high: 'high' },
    },
    thinkingLevel: 'high',
    tools: [expectedTool],
  };
  const session = {
    model: structuredClone(snapshot.model),
    thinkingLevel: 'high',
    getActiveToolNames: () => ['read'],
    getAllTools: () => [structuredClone(expectedTool)],
  };
  assert.doesNotThrow(() => assertChildCapabilities(session, snapshot));
  session.getAllTools = () => [{ ...expectedTool, sourceInfo: source('<builtin:read>', 'builtin') }];
  assert.throws(() => assertChildCapabilities(session, snapshot), /provenance|source/i);
  session.getAllTools = () => [structuredClone(expectedTool)];
  session.thinkingLevel = 'medium';
  assert.throws(() => assertChildCapabilities(session, snapshot), /thinking/i);
  session.thinkingLevel = 'high';
  session.model.contextWindow = 8192;
  session.model.maxTokens = 2048;
  session.model.cost.output = 99;
  assert.throws(() => assertChildCapabilities(session, snapshot), /model.*incompatible/i);
  session.model = structuredClone(snapshot.model);
  session.model.thinkingLevelMap.high = 'max';
  assert.throws(() => assertChildCapabilities(session, snapshot), /model.*incompatible/i);
});
