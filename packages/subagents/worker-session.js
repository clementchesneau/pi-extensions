// Child Pi session of a worker, built from the parent's bootstrap. The session must reproduce
// the captured capabilities exactly; any divergence fails the startup instead of degrading.
import { accessSync, chmodSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  assertChildCapabilities,
  assertChildRequestAuthentication,
  assertChildRequestCapabilities,
  createChildResourceConfiguration,
} from './child-resources.js';
import { validatePiRuntimeDescriptor } from './pi-compatibility.js';

/** Checks what the worker needs from the bootstrap before building anything. */
export function assertWorkerBootstrap(bootstrap) {
  if (bootstrap?.version !== 1) throw new Error('Unsupported subagent bootstrap version');
  if (
    !isAbsolute(bootstrap.cwd) ||
    !isAbsolute(bootstrap.agentDir) ||
    (bootstrap.sessionFile !== undefined && !isAbsolute(bootstrap.sessionFile))
  ) {
    throw new Error('Worker cwd, agentDir and sessionFile must be absolute');
  }
  for (const skill of bootstrap.capabilitySnapshot?.prompt?.skills ?? []) {
    try {
      accessSync(skill.filePath);
    } catch (error) {
      throw new Error(`Captured skill is unavailable: ${skill.filePath}`, { cause: error });
    }
  }
}

function reportBootstrapError(bootstrap, message, error, fatal) {
  process.send?.({ type: 'subagent-bootstrap-error', instanceId: bootstrap.instanceId, message });
  setImmediate(() => fatal(error));
}

/** Makes the child session file private; false while Pi has not created it yet. */
function secureSessionFile(ctx, bootstrap, { required = false } = {}) {
  const sessionFile = ctx.sessionManager.getSessionFile?.();
  if (!sessionFile) {
    if (required && bootstrap.sessionDir) throw new Error('Child session file was not created before completion');
    return false;
  }
  chmodSync(sessionFile, 0o600);
  return true;
}

function secureSessionWhenCreated(ctx, bootstrap, fatal) {
  const attempt = () => {
    try {
      if (!secureSessionFile(ctx, bootstrap)) return setTimeout(attempt, 10).unref?.();
    } catch (error) {
      if (error?.code === 'ENOENT') return setTimeout(attempt, 10).unref?.();
      reportBootstrapError(bootstrap, `Cannot secure child session: ${error.message}`, error, fatal);
    }
  };
  attempt();
}

/** The reason the started session cannot serve this bootstrap, if any. */
function startupFailure(pi, ctx, bootstrap, snapshot) {
  try {
    validatePiRuntimeDescriptor(bootstrap.piRuntime);
  } catch (error) {
    return { error, message: error.message };
  }
  if (!snapshot) return undefined;
  try {
    assertChildCapabilities(
      {
        model: ctx.model,
        thinkingLevel: ctx.thinkingLevel,
        getActiveToolNames: () => pi.getActiveTools(),
        getAllTools: () => pi.getAllTools(),
      },
      snapshot,
    );
  } catch (error) {
    return { error, message: error instanceof Error ? error.message : String(error) };
  }
  return undefined;
}

/** Extension announcing readiness to the parent once the child session has started as captured. */
export function createReadinessExtension(bootstrap, { version, fatal }) {
  const snapshot = bootstrap.capabilitySnapshot;
  let announced = false;
  return {
    name: 'subagent-readiness',
    factory(pi) {
      pi.on('session_start', (_event, ctx) => {
        if (announced) return;
        const failure = startupFailure(pi, ctx, bootstrap, snapshot);
        if (failure) {
          announced = true;
          reportBootstrapError(bootstrap, failure.message, failure.error, fatal);
          return;
        }
        pi.on('agent_end', () => secureSessionFile(ctx, bootstrap, { required: true }));
        secureSessionWhenCreated(ctx, bootstrap, fatal);
        announced = true;
        process.send?.({
          type: 'subagent-ready',
          instanceId: bootstrap.instanceId,
          piRuntime: { entry: bootstrap.piRuntime.entry, version, fingerprint: bootstrap.piRuntime.fingerprint },
        });
      });
    },
  };
}

/** Settings and resource loader options: the captured ones, or only the bootstrap's explicit resources. */
export function childResourceSetup(bootstrap, readinessExtension, sdk) {
  const snapshot = bootstrap.capabilitySnapshot;
  if (snapshot) {
    const { settingsManager, resourceLoaderOptions } = createChildResourceConfiguration(snapshot, {
      readinessExtension,
      sdk,
    });
    return { settingsManager, resourceOptions: resourceLoaderOptions };
  }
  return {
    resourceOptions: {
      additionalExtensionPaths: bootstrap.resources.extensionPaths ?? [],
      additionalSkillPaths: bootstrap.resources.skillPaths ?? [],
      additionalPromptTemplatePaths: bootstrap.resources.promptTemplatePaths ?? [],
      extensionFactories: [readinessExtension],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: bootstrap.resources.contextFiles === false,
    },
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true } }),
  };
}

function assertCleanStartup(services) {
  const extensionErrors = services.resourceLoader.getExtensions().errors.map(item => `${item.path}: ${item.error}`);
  const resourceErrors = [services.resourceLoader.getSkills(), services.resourceLoader.getPrompts()]
    .flatMap(result => result.diagnostics)
    .filter(item => item.type === 'error')
    .map(item => item.message);
  const fatalDiagnostics = services.diagnostics.filter(item => item.type === 'error').map(item => item.message);
  const startupErrors = [...extensionErrors, ...resourceErrors, ...fatalDiagnostics];
  if (startupErrors.length) throw new Error(startupErrors.join('\n'));
}

async function setRuntimeApiKey(modelRuntime, provider, apiKey) {
  if (modelRuntime.isUsingOAuth(provider) || modelRuntime.isUsingSubscription(provider)) {
    throw new Error(`Runtime API key override is incompatible with OAuth/subscription provider ${provider}`);
  }
  await modelRuntime.setRuntimeApiKey(provider, apiKey);
}

async function applyPrivateCapabilities(modelRuntime, bootstrap) {
  for (const registration of bootstrap.privateCapabilities?.providerRegistrations ?? []) {
    if (
      !registration ||
      typeof registration.id !== 'string' ||
      !registration.config ||
      typeof registration.config !== 'object'
    ) {
      throw new Error('Captured provider registration is not declarative and reproducible');
    }
    modelRuntime.registerProvider(registration.id, registration.config);
  }
  if (bootstrap.auth?.apiKey) await setRuntimeApiKey(modelRuntime, bootstrap.model.provider, bootstrap.auth.apiKey);
  for (const [provider, apiKey] of Object.entries(bootstrap.privateCapabilities?.runtimeApiKeys ?? {})) {
    if (typeof apiKey !== 'string' || !apiKey) throw new Error(`Invalid runtime API key override for ${provider}`);
    await setRuntimeApiKey(modelRuntime, provider, apiKey);
  }
}

async function resolveChildModel(modelRuntime, bootstrap, snapshot) {
  const { provider, id } = bootstrap.model;
  const providerImplementation = snapshot?.model?.providerImplementation;
  const providerIsRegistered = modelRuntime.getRegisteredProviderIds().includes(provider);
  if (providerImplementation?.kind === 'builtin' && providerIsRegistered) {
    throw new Error(`Provider ${provider} unexpectedly differs from the captured built-in implementation`);
  }
  if (['declarative', 'extension'].includes(providerImplementation?.kind) && !providerIsRegistered) {
    throw new Error(`Captured provider ${provider} was not reproduced in the child`);
  }
  const model = modelRuntime.getModel(provider, id);
  if (!model) throw new Error(`Configured model is unavailable: ${provider}/${id}`);
  if (snapshot) {
    // Pi may resolve ambient credentials (for example AWS IAM/Bedrock or
    // Google ADC) as auth: {}. A successful resolution is authoritative;
    // its internal apiKey/headers shape is provider-specific.
    await assertChildRequestAuthentication(modelRuntime, model, snapshot);
    const actualAuthMode = modelRuntime.isUsingOAuth(model.provider) ? 'oauth' : 'configured';
    if (snapshot.model.authMode && snapshot.model.authMode !== actualAuthMode) {
      throw new Error(`Authentication mode for ${model.provider} differs from the parent snapshot`);
    }
  }
  return model;
}

/** Re-checks the captured capabilities and authentication before every model request. */
function guardRequests(created, modelRuntime, snapshot) {
  const nativeStream = created.session.agent.streamFunction;
  created.session.agent.streamFunction = async (requestModel, context, options) => {
    const requestThinking = options?.reasoning ?? created.session.agent.state.thinkingLevel;
    assertChildRequestCapabilities(
      {
        model: requestModel,
        thinkingLevel: requestThinking,
        getActiveToolNames: () => created.session.getActiveToolNames(),
        getAllTools: () => created.session.getAllTools(),
      },
      snapshot,
    );
    await assertChildRequestAuthentication(modelRuntime, requestModel, snapshot);
    return nativeStream(requestModel, context, options);
  };
}

/** Runtime factory handed to Pi's createAgentSessionRuntime. */
export function createRuntimeFactory({ sdk, bootstrap, settingsManager, resourceOptions }) {
  const { createAgentSessionServices, createAgentSessionFromServices } = sdk;
  const snapshot = bootstrap.capabilitySnapshot;
  return async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: bootstrap.agentDir,
      settingsManager,
      resourceLoaderOptions: resourceOptions,
    });
    assertCleanStartup(services);
    await applyPrivateCapabilities(services.modelRuntime, bootstrap);
    const model = await resolveChildModel(services.modelRuntime, bootstrap, snapshot);
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      thinkingLevel: bootstrap.thinkingLevel,
      tools: bootstrap.allowedTools,
    });
    if (snapshot) guardRequests(created, services.modelRuntime, snapshot);
    return { ...created, services, diagnostics: services.diagnostics };
  };
}

/** Session manager of the child: a continued file, a new persisted session or an in-memory one. */
export function openChildSessionManager(SessionManager, bootstrap) {
  const sessionOptions = {
    id: bootstrap.instanceId,
    ...(bootstrap.parentSessionId ? { parentSession: bootstrap.parentSessionId } : {}),
  };
  if (bootstrap.sessionFile) {
    try {
      const file = lstatSync(bootstrap.sessionFile);
      if (!file.isFile() || file.size === 0) throw new Error('missing or empty session file');
    } catch (error) {
      throw new Error(`Child transcription is unavailable for continuation: ${error.message}`, { cause: error });
    }
  }
  const sessionManager = bootstrap.sessionFile
    ? SessionManager.open(bootstrap.sessionFile, bootstrap.sessionDir, bootstrap.cwd)
    : bootstrap.sessionDir
      ? SessionManager.create(bootstrap.cwd, bootstrap.sessionDir, sessionOptions)
      : SessionManager.inMemory(bootstrap.cwd, sessionOptions);
  if (
    bootstrap.sessionFile &&
    (sessionManager.getHeader()?.id !== bootstrap.instanceId ||
      !sessionManager.getEntries().some(entry => entry.type === 'message' && entry.message?.role === 'user'))
  ) {
    throw new Error(
      'Child transcription is unavailable for continuation: no matching session with previous user messages',
    );
  }
  return sessionManager;
}

/** Steering is accepted only while the agent streams, and only if it is consumed before the agent ends. */
export function guardSteering(session) {
  const nativeSteer = session.steer.bind(session);
  session.steer = async (text, images) => {
    if (!session.isStreaming) throw new Error('Agent is not streaming; steering was rejected');
    await nativeSteer(text, images);
    if (!session.isStreaming) {
      session.clearQueue();
      throw new Error('Agent finished before steering could be consumed');
    }
  };
}
