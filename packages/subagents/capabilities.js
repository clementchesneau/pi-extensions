import { existsSync, realpathSync } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CAPABILITY_SNAPSHOT_VERSION = 1;
const DELEGATION_TOOL_PATTERN = /^(?:subagents?|delegate)(?:_|$)/iu;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

function cloneSerializable(value, label) {
  try {
    const clone = structuredClone(value);
    JSON.stringify(clone);
    return clone;
  } catch (error) {
    throw new TypeError(`${label} is not serializable`, { cause: error });
  }
}

// This extension's own entry point, wherever it is installed, plus other copies in
// the workspace folder or the npm package folder.
const OWN_ENTRY = canonicalPath(fileURLToPath(new URL('./index.js', import.meta.url)));
const COORDINATOR_FOLDERS = new Set(['subagents', 'pi-subagents']);

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isSubagentCoordinatorSource(path) {
  if (typeof path !== 'string' || !['index.js', 'index.mjs', 'index.ts'].includes(basename(path))) return false;
  return COORDINATOR_FOLDERS.has(basename(dirname(path))) || canonicalPath(path) === OWN_ENTRY;
}

function isDelegationTool(tool) {
  return DELEGATION_TOOL_PATTERN.test(tool?.name ?? '') || isSubagentCoordinatorSource(tool?.sourceInfo?.path);
}

function isSdkTool(tool) {
  return tool?.sourceInfo?.source === 'sdk' || /^<sdk:/u.test(tool?.sourceInfo?.path ?? '');
}

export function selectCapabilityTools(activeTools, requestedTools) {
  const byName = new Map(activeTools.map(tool => [tool.name, tool]));
  const inherited = requestedTools === undefined;
  const names = inherited ? activeTools.map(tool => tool.name) : requestedTools;
  if (!Array.isArray(names) || !names.every(name => typeof name === 'string'))
    throw new TypeError('tools must be an array of names when provided');
  const selected = [];
  for (const name of [...new Set(names)]) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Requested tool "${name}" is not active in the parent session`);
    if (isDelegationTool(tool)) {
      if (inherited) continue;
      throw new Error(`Subagent delegation tool "${name}" is not allowed in a child`);
    }
    if (isSdkTool(tool)) {
      if (inherited) throw new Error(`Active tool "${name}" is not reproducible because it exists only in SDK memory`);
      throw new Error(`Requested tool "${name}" is not reproducible because it exists only in SDK memory`);
    }
    selected.push(tool);
  }
  return selected;
}

export function captureOperationalSettings(settingsManager) {
  return {
    shellPath: settingsManager.getShellPath(),
    shellCommandPrefix: settingsManager.getShellCommandPrefix(),
    transport: settingsManager.getTransport(),
    steeringMode: settingsManager.getSteeringMode(),
    followUpMode: settingsManager.getFollowUpMode(),
    compaction: settingsManager.getCompactionSettings(),
    retry: settingsManager.getRetrySettings(),
    providerRetry: settingsManager.getProviderRetrySettings(),
    httpIdleTimeoutMs: settingsManager.getHttpIdleTimeoutMs(),
    websocketConnectTimeoutMs: settingsManager.getWebSocketConnectTimeoutMs(),
    thinkingBudgets: settingsManager.getThinkingBudgets(),
    imageAutoResize: settingsManager.getImageAutoResize(),
    blockImages: settingsManager.getBlockImages(),
    showImages: settingsManager.getShowImages(),
  };
}

function modelSnapshot(model) {
  if (!model?.provider || !model?.id) throw new Error('The parent session has no active model');
  // Model headers may contain Authorization or provider-specific credentials.
  // The child resolves them from normal auth or the private IPC bootstrap.
  const fields = [
    'provider',
    'id',
    'name',
    'api',
    'baseUrl',
    'reasoning',
    'input',
    'cost',
    'contextWindow',
    'maxTokens',
    'compat',
    'thinkingLevelMap',
  ];
  return Object.fromEntries(
    fields.filter(key => model[key] !== undefined).map(key => [key, cloneSerializable(model[key], `model.${key}`)]),
  );
}

function extensionSourcePath(sourceInfo) {
  if (!sourceInfo || ['builtin', 'sdk'].includes(sourceInfo.source)) return undefined;
  if (typeof sourceInfo.path !== 'string' || !isAbsolute(sourceInfo.path) || sourceInfo.path.startsWith('<'))
    return undefined;
  if (isSubagentCoordinatorSource(sourceInfo.path)) return undefined;
  return sourceInfo.path;
}

// Pi treats every other `-e` value as a local path (see its isLocalPath).
const REMOTE_SOURCE = /^(?:npm|git|github|http|https|ssh|builtin):/u;

/** `-e`/`--extension` values of a Pi command line, in order, and whether it disables other extensions. */
function cliExtensionArgs(argv) {
  const sources = [];
  let noExtensions = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--no-extensions' || argv[index] === '-ne') noExtensions = true;
    else if (['-e', '--extension'].includes(argv[index]) && index + 1 < argv.length) sources.push(argv[++index]);
  }
  return { sources, noExtensions };
}

function localCliPath(source) {
  const trimmed = source.trim();
  if (REMOTE_SOURCE.test(trimmed)) return undefined;
  const path = trimmed === '~' || trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(1)) : resolve(trimmed);
  return existsSync(path) ? path : undefined;
}

/**
 * Parent extension paths in the order the Pi CLI loaded them: `-e` sources, then, unless
 * `--no-extensions`, settings packages and entries as Pi's own package manager orders them.
 * Only a CLI parent's arguments are known: an SDK host may load other paths or ignore
 * settings, so no order is claimed for it (`cli: false`) and several inherited sources
 * are then refused. Missing sources are skipped, never installed; remote `-e` sources are
 * left out because resolving them may fetch.
 */
export async function resolveExtensionLoadOrder({ sdk, cwd, agentDir, settingsManager, cli, argv = process.argv }) {
  if (!cli || typeof sdk?.DefaultPackageManager !== 'function') return [];
  const { sources, noExtensions } = cliExtensionArgs(argv);
  const packages = new sdk.DefaultPackageManager({ cwd, agentDir, settingsManager });
  const local = sources.map(localCliPath).filter(path => path !== undefined);
  const loaded = [...(await packages.resolveExtensionSources(local, { temporary: true })).extensions];
  if (!noExtensions) loaded.push(...(await packages.resolve(async () => 'skip')).extensions);
  return loaded.filter(item => item.enabled).map(item => item.path);
}

async function canonicalExistingFile(path, label) {
  try {
    await access(path);
    return await realpath(path);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${path}`, { cause: error });
  }
}

/** Canonical paths of the extensions behind the selected tools and the parent's extension commands. */
async function inheritedExtensionPaths(selected, commands) {
  const sourcePaths = new Set();
  for (const tool of selected) {
    const path = extensionSourcePath(tool.sourceInfo);
    if (path) sourcePaths.add(path);
  }
  for (const command of commands) {
    if (command.source !== 'extension') continue;
    const path = extensionSourcePath(command.sourceInfo);
    if (path) sourcePaths.add(path);
  }
  const extensionPaths = [];
  const canonicalSources = new Map();
  for (const path of sourcePaths) {
    const canonical = await canonicalExistingFile(path, 'Extension source');
    canonicalSources.set(path, canonical);
    extensionPaths.push(canonical);
  }
  for (const tool of selected) {
    if (canonicalSources.has(tool.sourceInfo?.path)) tool.sourceInfo.path = canonicalSources.get(tool.sourceInfo.path);
  }
  return extensionPaths;
}

async function capturePrompt(systemPromptOptions) {
  const prompt = cloneSerializable(
    {
      customPrompt: systemPromptOptions.customPrompt,
      appendSystemPrompt: systemPromptOptions.appendSystemPrompt,
      promptGuidelines: systemPromptOptions.promptGuidelines ?? [],
      contextFiles: systemPromptOptions.contextFiles ?? [],
      skills: systemPromptOptions.skills ?? [],
    },
    'Structured system prompt',
  );
  for (const skill of prompt.skills) {
    if (!skill.filePath || !isAbsolute(skill.filePath))
      throw new Error(`Skill "${skill.name ?? 'unknown'}" has no accessible absolute file path`);
    await canonicalExistingFile(skill.filePath, `Skill "${skill.name ?? skill.filePath}"`);
  }
  return prompt;
}

/** Whether a registered provider is plain configuration the child can register again. */
function isDeclarativeProvider(registry, provider) {
  const registeredConfig = registry.getRegisteredProviderConfig?.(provider);
  const registeredNative = registry.getRegisteredNativeProvider?.(provider);
  if (!registeredConfig || registeredNative) return false;
  try {
    cloneSerializable(registeredConfig, `Provider ${provider} registration`);
    return true;
  } catch {
    return false;
  }
}

async function providerExtensionSource(provider, providerSourcePaths) {
  const sourcePath = providerSourcePaths[provider];
  if (!sourcePath) {
    throw new Error(`Provider ${provider} is not reproducible: its implementation exists only in parent memory`);
  }
  const canonical = await canonicalExistingFile(sourcePath, `Provider ${provider} source`);
  if (isSubagentCoordinatorSource(canonical))
    throw new Error(`Provider ${provider} cannot use the subagent coordinator as its child source`);
  return canonical;
}

/** Records how the child reproduces the model's provider, adding its extension source when it has one. */
async function describeProvider(ctx, model, providerSourcePaths, extensionPaths) {
  const canInspectProvider = typeof ctx.modelRegistry?.getRegisteredProviderIds === 'function';
  const registeredProviderIds = new Set(canInspectProvider ? ctx.modelRegistry.getRegisteredProviderIds() : []);
  if (!registeredProviderIds.has(model.provider)) {
    if (canInspectProvider) model.providerImplementation = { kind: 'builtin' };
    return;
  }
  if (isDeclarativeProvider(ctx.modelRegistry, model.provider)) {
    model.providerImplementation = { kind: 'declarative' };
    return;
  }
  const canonical = await providerExtensionSource(model.provider, providerSourcePaths);
  if (!extensionPaths.includes(canonical)) extensionPaths.push(canonical);
  model.providerImplementation = { kind: 'extension', path: canonical };
}

async function describeAuthentication(ctx, model) {
  if (!ctx.modelRegistry?.getProviderAuth) return;
  let providerAuth;
  try {
    providerAuth = await ctx.modelRegistry.getProviderAuth(model.provider);
  } catch (error) {
    throw new Error(`Could not resolve authentication for provider ${model.provider}`, { cause: error });
  }
  const requestBaseUrl = providerAuth?.auth?.baseUrl;
  if (requestBaseUrl !== undefined) model.requestBaseUrl = requestBaseUrl;
  // A resolved auth object can deliberately contain no API key or headers:
  // Pi supports ambient credentials such as AWS IAM/Bedrock bearer and GCP
  // ADC, which are applied by the provider runtime.
  model.authMode = ctx.modelRegistry.isUsingOAuth?.(ctx.model) ? 'oauth' : providerAuth ? 'configured' : 'missing';
}

// The tool registry retains a tool name's original insertion slot when a
// later extension replaces it, so getAllTools() cannot recover extension
// priority. Only the caller can attest the parent's actual load order; the
// settings alone cannot, since a parent may have ignored them.
async function orderExtensionPaths(extensionPaths, extensionLoadOrder, cwd) {
  const includedSources = new Set(extensionPaths);
  const orderedExtensionPaths = [];
  for (const configuredPath of extensionLoadOrder) {
    if (typeof configuredPath !== 'string') continue;
    try {
      const canonical = await realpath(isAbsolute(configuredPath) ? configuredPath : resolve(cwd, configuredPath));
      if (includedSources.delete(canonical)) orderedExtensionPaths.push(canonical);
    } catch {}
  }
  // A sole source has no relative priority to preserve. Otherwise every
  // inherited source must be ordered: a single unclassified source could be
  // before or after an already-classified source and change an override.
  if (includedSources.size > 0 && orderedExtensionPaths.length > 0) {
    throw new Error(
      'Extension load order is incomplete for inherited sources; provide extensionLoadOrder from the parent resource loader',
    );
  }
  if (includedSources.size > 1)
    throw new Error(
      'Extension load order is unavailable for multiple inherited sources; provide extensionLoadOrder from the parent resource loader',
    );
  orderedExtensionPaths.push(...includedSources);
  return orderedExtensionPaths;
}

/** Capture only capabilities and structured prompt inputs; parent messages are deliberately not accepted. */
export async function captureCapabilitySnapshot({
  pi,
  ctx,
  systemPromptOptions,
  settingsManager,
  parentSessionId = null,
  agentDir,
  tools,
  providerSourcePaths = {},
  extensionLoadOrder = [],
}) {
  if (!pi || !ctx || !systemPromptOptions || !settingsManager)
    throw new TypeError('pi, ctx, systemPromptOptions and settingsManager are required');
  if (!Array.isArray(extensionLoadOrder) || !extensionLoadOrder.every(path => typeof path === 'string')) {
    throw new TypeError('extensionLoadOrder must be an array of parent extension paths');
  }
  const allTools = pi.getAllTools();
  const commands = pi.getCommands?.() ?? [];
  const activeNames = new Set(pi.getActiveTools());
  const activeTools = allTools.filter(tool => activeNames.has(tool.name));
  const selected = selectCapabilityTools(activeTools, tools).map(tool => cloneSerializable(tool, `tool ${tool.name}`));
  const extensionPaths = await inheritedExtensionPaths(selected, commands);
  const prompt = await capturePrompt(systemPromptOptions);
  const model = modelSnapshot(ctx.model);
  await describeProvider(ctx, model, providerSourcePaths, extensionPaths);
  await describeAuthentication(ctx, model);
  const orderedExtensionPaths = await orderExtensionPaths(extensionPaths, extensionLoadOrder, ctx.cwd);

  const snapshot = {
    version: CAPABILITY_SNAPSHOT_VERSION,
    parentSessionId,
    cwd: ctx.cwd,
    agentDir,
    projectTrusted: ctx.isProjectTrusted(),
    model,
    thinkingLevel: ctx.thinkingLevel ?? 'off',
    tools: selected,
    extensionPaths: orderedExtensionPaths,
    prompt,
    settings: captureOperationalSettings(settingsManager),
  };
  const serializable = cloneSerializable(snapshot, 'Capability snapshot');
  if (Buffer.byteLength(JSON.stringify(serializable)) > MAX_SNAPSHOT_BYTES)
    throw new Error('Capability snapshot exceeds the 32 MiB bootstrap limit');
  return serializable;
}

/** Kept outside persistable capability metadata; pass only through the worker's private IPC bootstrap. */
export function capturePrivateCapabilityBootstrap({ runtimeApiKeys = {}, providerRegistrations = [] } = {}) {
  return cloneSerializable({ runtimeApiKeys, providerRegistrations }, 'Private capability bootstrap');
}
