import { isDeepStrictEqual } from 'node:util';

export const CHILD_BOOTSTRAP_ENV = 'PI_SUBAGENT_CHILD';
const CHILD_INSTRUCTIONS =
  'You are an independent child agent. Work only on the delegated mission and selected context. You must not delegate to another subagent.';

function settingsFromSnapshot(snapshot) {
  const value = snapshot.settings ?? {};
  return {
    shellPath: value.shellPath,
    shellCommandPrefix: value.shellCommandPrefix,
    transport: value.transport,
    steeringMode: value.steeringMode,
    followUpMode: value.followUpMode,
    compaction: value.compaction,
    retry:
      value.retry || value.providerRetry
        ? { ...(value.retry ?? {}), ...(value.providerRetry ? { provider: value.providerRetry } : {}) }
        : undefined,
    httpIdleTimeoutMs: value.httpIdleTimeoutMs,
    websocketConnectTimeoutMs: value.websocketConnectTimeoutMs,
    thinkingBudgets: value.thinkingBudgets,
    images: { autoResize: value.imageAutoResize, blockImages: value.blockImages },
    terminal: { showImages: value.showImages },
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  };
}

export function createCapabilityGuardExtension(expectedTools) {
  const expectedByName = new Map(expectedTools.map(tool => [tool.name, tool]));
  const ceiling = new Set(expectedByName.keys());
  return {
    name: 'subagent-capability-guard',
    factory(pi) {
      const enforce = () => pi.setActiveTools(pi.getActiveTools().filter(name => ceiling.has(name)));
      pi.on('session_start', enforce);
      pi.on('before_agent_start', enforce);
      pi.on('tool_call', event => {
        if (!ceiling.has(event.toolName))
          return {
            block: true,
            terminate: true,
            reason: `Tool "${event.toolName}" is outside the child capability ceiling`,
          };
        const actual = pi.getAllTools().find(tool => tool.name === event.toolName);
        if (!actual || !isDeepStrictEqual(comparableTool(actual), comparableTool(expectedByName.get(event.toolName)))) {
          return {
            block: true,
            terminate: true,
            reason: `Tool "${event.toolName}" changed schema or provenance after child bootstrap`,
          };
        }
        return undefined;
      });
    },
  };
}

/**
 * @param {any} snapshot
 * @param {{
 *   readinessExtension?: import('@earendil-works/pi-coding-agent').InlineExtension,
 *   sdk?: typeof import('@earendil-works/pi-coding-agent'),
 * }} [options]
 */
export function createChildResourceConfiguration(snapshot, { readinessExtension, sdk } = {}) {
  if (typeof sdk?.SettingsManager?.inMemory !== 'function')
    throw new Error('Child resources require host SDK SettingsManager.inMemory');
  const { SettingsManager } = sdk;
  const prompt = snapshot.prompt ?? {};
  const settingsManager = SettingsManager.inMemory(settingsFromSnapshot(snapshot), {
    projectTrusted: snapshot.projectTrusted === true,
  });
  /** @type {import('@earendil-works/pi-coding-agent').InlineExtension[]} */
  const extensionFactories = [createCapabilityGuardExtension(snapshot.tools ?? [])];
  if (readinessExtension) extensionFactories.push(readinessExtension);
  return {
    settingsManager,
    resourceLoaderOptions: {
      additionalExtensionPaths: snapshot.extensionPaths ?? [],
      additionalSkillPaths: [],
      additionalPromptTemplatePaths: [],
      additionalThemePaths: [],
      extensionFactories,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: prompt.customPrompt,
      appendSystemPrompt: [],
      skillsOverride: base => ({ ...base, skills: structuredClone(prompt.skills ?? []) }),
      agentsFilesOverride: base => ({ ...base, agentsFiles: structuredClone(prompt.contextFiles ?? []) }),
      systemPromptOverride: () => prompt.customPrompt,
      // Pi derives promptGuidelines from the active tool definitions. Those
      // definitions are verified against the snapshot; adding the captured
      // values here would duplicate them, and would diverge when customPrompt
      // intentionally suppresses native guidelines.
      appendSystemPromptOverride: () => [prompt.appendSystemPrompt, CHILD_INSTRUCTIONS].filter(Boolean),
    },
  };
}

function modelMatches(actual, expected, { allowRequestBaseUrl = false } = {}) {
  const fields = [
    'provider',
    'id',
    'api',
    'reasoning',
    'input',
    'compat',
    'cost',
    'contextWindow',
    'maxTokens',
    'thinkingLevelMap',
  ];
  if (
    !fields.filter(key => expected?.[key] !== undefined).every(key => isDeepStrictEqual(actual?.[key], expected[key]))
  )
    return false;
  if (expected?.baseUrl === undefined) return true;
  if (isDeepStrictEqual(actual?.baseUrl, expected.baseUrl)) return true;
  return (
    allowRequestBaseUrl &&
    expected.requestBaseUrl !== undefined &&
    isDeepStrictEqual(actual?.baseUrl, expected.requestBaseUrl)
  );
}

function jsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sourceIdentity(sourceInfo) {
  if (!sourceInfo) return undefined;
  if (sourceInfo.source === 'builtin' || /^<builtin:/u.test(sourceInfo.path ?? '')) {
    return { kind: 'builtin', path: sourceInfo.path };
  }
  if (sourceInfo.source === 'sdk' || /^<sdk:/u.test(sourceInfo.path ?? '')) {
    return { kind: 'sdk', path: sourceInfo.path };
  }
  if (typeof sourceInfo.path === 'string' && !sourceInfo.path.startsWith('<')) {
    // Reloading the same file through additionalExtensionPaths intentionally
    // changes source/scope/origin to cli/temporary/top-level. Those fields
    // describe the loading channel, not the extension's executable identity.
    return { kind: 'file', path: sourceInfo.path };
  }
  return { kind: 'synthetic', sourceInfo: jsonValue(sourceInfo) };
}

function comparableTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: jsonValue(tool.parameters),
    promptGuidelines: jsonValue(tool.promptGuidelines),
    sourceInfo: sourceIdentity(tool.sourceInfo),
  };
}

function assertCapabilities(session, snapshot, { allowRequestBaseUrl = false } = {}) {
  if (!modelMatches(session.model, snapshot.model, { allowRequestBaseUrl })) {
    throw new Error(`Child model is incompatible with captured model ${snapshot.model.provider}/${snapshot.model.id}`);
  }
  if (session.thinkingLevel !== snapshot.thinkingLevel) {
    throw new Error(
      `Child thinking level ${session.thinkingLevel} does not match captured level ${snapshot.thinkingLevel}`,
    );
  }
  const expectedNames = snapshot.tools.map(tool => tool.name);
  const activeNames = session.getActiveToolNames();
  if (!isDeepStrictEqual(activeNames, expectedNames))
    throw new Error(
      `Child active tools differ from capability snapshot: expected [${expectedNames}], received [${activeNames}]`,
    );
  const available = new Map(session.getAllTools().map(tool => [tool.name, tool]));
  for (const expected of snapshot.tools) {
    const actual = available.get(expected.name);
    if (!actual) throw new Error(`Required child tool "${expected.name}" is unavailable`);
    const actualComparable = comparableTool(actual);
    const expectedComparable = comparableTool(expected);
    if (!isDeepStrictEqual(actualComparable, expectedComparable)) {
      const differences = Object.keys(expectedComparable).filter(
        key => !isDeepStrictEqual(actualComparable[key], expectedComparable[key]),
      );
      throw new Error(
        `Required child tool "${expected.name}" has incompatible ${differences.join(', ') || 'schema or provenance/source'}`,
      );
    }
  }
  return true;
}

export function assertChildCapabilities(session, snapshot) {
  return assertCapabilities(session, snapshot);
}

export function assertChildRequestCapabilities(session, snapshot) {
  return assertCapabilities(session, snapshot, { allowRequestBaseUrl: true });
}

/** Resolve provider auth for every request because refreshes may change its endpoint. */
export async function assertChildRequestAuthentication(modelRuntime, model, snapshot) {
  const auth = await modelRuntime.getAuth(model);
  if (!auth) throw new Error(`Authentication is unavailable for ${model.provider}`);
  const expectedBaseUrl = snapshot.model.requestBaseUrl ?? snapshot.model.baseUrl;
  const actualBaseUrl = auth.auth?.baseUrl ?? model.baseUrl;
  if (expectedBaseUrl !== undefined && expectedBaseUrl !== actualBaseUrl) {
    throw new Error(`Effective baseUrl for ${model.provider} differs from the parent snapshot`);
  }
  return auth;
}
