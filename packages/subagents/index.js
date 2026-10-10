import {
  captureCapabilitySnapshot,
  capturePrivateCapabilityBootstrap,
  resolveExtensionLoadOrder,
} from './capabilities.js';
import { connectActivityIndicator } from '@clement_chsn/pi-shared/activity-indicator';
import { defaultConfigPath, loadSubagentConfig, updateSubagentConfig } from './config.js';
import { formatSubagentContext } from './delivery.js';
import { defaultModelGuidePath } from './model-guide.js';
import { createSubagentRuntime } from './runtime.js';
import { isPiCliProcess, loadHostPiRuntime, loadParentPiHost, resolveHostPiRuntime } from './pi-compatibility.js';
import { createSubagentSession, notify, STATE_ENTRY, summary } from './session.js';
import { createSubagentTools } from './tools.js';
import { registerSubagentRenderers } from './renderers.js';
import { createSubagentUI } from './ui.js';

/** @param {{ agentId?: string, runId?: string }} identity */
const readKey = ({ agentId, runId }) => `${agentId}:${runId}`;

/** Completed results already read through subagent_result on this branch. */
function readRunsOnBranch(entries) {
  return new Set(
    entries
      .filter(
        entry =>
          entry.type === 'message' &&
          entry.message?.role === 'toolResult' &&
          entry.message.toolName === 'subagent_result' &&
          !entry.message.isError &&
          entry.message.details?.agentId &&
          entry.message.details?.runId &&
          entry.message.details.state === 'completed' &&
          (typeof entry.message.details.text === 'string' || typeof entry.message.details.result === 'string'),
      )
      .map(entry => readKey(entry.message.details)),
  );
}

const branchIdsOf = (branchId, entries) => new Set([branchId, ...entries.map(entry => entry.id)]);

export default function subagents(pi, options = {}) {
  if (options.sdk !== undefined) return initializeSubagents(pi, options);
  // Keep this import in the entry point: Pi's SDK loader aliases it to the host.
  // Explicit injection never needs a local SDK, even just to import this module.
  return loadParentPiHost({ loadSdk: () => import('@earendil-works/pi-coding-agent') }).then(host =>
    initializeSubagents(pi, { ...options, sdk: host.sdk }, host.error),
  );
}

/**
 * Extension-wide state. `runtime` is the current session's subagents; `generation` changes
 * whenever it is replaced, so callbacks of a previous session can recognize themselves.
 */
function createExtensionState(options, initializationError) {
  const { sdk } = options;
  // Observe disk identity during extension initialization, not on the first mission.
  // Preserve archive reads even when the host can no longer launch new workers.
  let hostInitializationError = initializationError;
  try {
    resolveHostPiRuntime({ sdk });
  } catch (error) {
    hostInitializationError = error;
  }
  return {
    ...options,
    hostRuntime() {
      if (hostInitializationError) throw hostInitializationError;
      return resolveHostPiRuntime({ sdk });
    },
    loadRuntime: piRuntime => loadHostPiRuntime(piRuntime, { expectedSdk: sdk }),
    runtime: undefined,
    generation: 0,
    lastPromptOptions: undefined,
    pendingShutdowns: new Set(),
  };
}

/**
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
 * @param {{
 *   sdk?: typeof import('@earendil-works/pi-coding-agent'),
 *   agentDir?: string,
 *   configPath?: string,
 *   modelGuidePath?: string,
 *   createRuntime?: typeof createSubagentRuntime,
 *   dialogTimeoutMs?: number,
 * }} [options]
 * @param {unknown} [initializationError]
 */
function initializeSubagents(
  pi,
  {
    sdk,
    agentDir = sdk.getAgentDir(),
    configPath = defaultConfigPath(),
    modelGuidePath = defaultModelGuidePath(),
    createRuntime = createSubagentRuntime,
    dialogTimeoutMs = 30_000,
  } = {},
  initializationError,
) {
  const ext = createExtensionState({ sdk, agentDir, configPath, createRuntime, dialogTimeoutMs }, initializationError);
  const indicator = connectActivityIndicator(pi);
  registerSubagentRenderers(pi, { wasRead: details => ext.runtime?.readRuns?.has(readKey(details)) ?? false });
  const tools = createSubagentTools({
    getManager: ctx => {
      if (ext.runtime && ctx) followLeaf(ext.runtime, ctx);
      return ext.runtime?.manager;
    },
    capture: (ctx, input) => capture(pi, ext, ctx, input),
    onResultRead: identity => ext.runtime?.readRuns?.add(readKey(identity)),
    modelGuidePath,
  });
  for (const tool of tools) pi.registerTool(tool);
  registerSessionLifecycle(pi, ext, indicator);
  registerConversationHooks(pi, ext);
  registerCommand(pi, ext);
}

/** Capabilities a new subagent inherits from the parent session, as the worker will replay them. */
async function capture(pi, ext, ctx, input) {
  const { sdk, agentDir } = ext;
  await ext.loadRuntime(ext.hostRuntime());
  const sourceModel =
    input.provider || input.modelId
      ? ctx.modelRegistry.find?.(input.provider ?? ctx.model?.provider, input.modelId ?? ctx.model?.id)
      : ctx.model;
  if (!sourceModel) throw new Error('The selected subagent model is unavailable in this parent session');
  const settingsManager = sdk.SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
  const systemPromptOptions = ext.lastPromptOptions ?? {
    cwd: ctx.cwd,
    customPrompt: undefined,
    appendSystemPrompt: undefined,
    contextFiles: [],
    skills: [],
    promptGuidelines: [],
  };
  const snapshot = await captureCapabilitySnapshot({
    pi,
    ctx: { ...ctx, model: sourceModel, thinkingLevel: input.thinkingLevel ?? ctx.thinkingLevel },
    systemPromptOptions,
    settingsManager,
    parentSessionId: ctx.sessionManager.getSessionId(),
    agentDir,
    tools: input.tools,
    extensionLoadOrder: await resolveExtensionLoadOrder({
      sdk,
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      cli: isPiCliProcess(),
    }),
  });
  const providerConfig =
    snapshot.model.providerImplementation?.kind === 'declarative'
      ? ctx.modelRegistry.getRegisteredProviderConfig?.(snapshot.model.provider)
      : undefined;
  const privateCapabilities = providerConfig
    ? capturePrivateCapabilityBootstrap({
        providerRegistrations: [{ id: snapshot.model.provider, config: providerConfig }],
      })
    : undefined;
  return {
    capabilitySnapshot: snapshot,
    model: { provider: snapshot.model.provider, id: snapshot.model.id },
    thinkingLevel: snapshot.thinkingLevel,
    tools: snapshot.tools.map(tool => tool.name),
    privateCapabilities,
  };
}

/** Stops the workers of replaced sessions and removes their private files. */
async function cleanupPending(ext) {
  const outcomes = await Promise.allSettled(
    [...ext.pendingShutdowns].map(async previous => {
      await previous.manager.shutdown();
      await previous.store.cleanup();
      ext.pendingShutdowns.delete(previous);
    }),
  );
  const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
  if (errors.length)
    throw new AggregateError(errors, `Subagent cleanup failed: ${errors.map(error => error.message).join('; ')}`);
}

function retire(ext) {
  ext.runtime = undefined;
  ext.generation += 1;
  ext.lastPromptOptions = undefined;
}

async function restoreAgents(runtime, ctx) {
  try {
    const onRestoreError = (agentId, error) =>
      notify(ctx, `Subagents: saved agent ${agentId} could not be restored (${error.message})`, 'warning');
    const archived = await runtime.store.loadAgents({ onError: onRestoreError });
    for (const agent of archived) {
      try {
        runtime.manager.restore([agent], { branchIds: runtime.branchIds });
      } catch (error) {
        onRestoreError(agent.agentId, error);
      }
    }
    for (const { agentId } of runtime.manager.compactAgents()) {
      const agent = runtime.manager.findAgent(agentId);
      for (const run of agent.runs) runtime.announce(agent, run);
    }
  } catch (error) {
    notify(ctx, `Subagents: saved state could not be restored (${error.message})`, 'warning');
  }
}

function createUI(ext, ctx, indicator) {
  const { configPath } = ext;
  const manager = ext.runtime.manager;
  return createSubagentUI({
    ctx,
    sdk: ext.sdk,
    manager,
    indicator,
    getConfig: () => loadSubagentConfig({ path: configPath }),
    updateConfig: patch =>
      updateSubagentConfig(patch, {
        path: configPath,
        validate: candidate => {
          const active = manager.activeAgentIds().length;
          if (candidate.maxConcurrent < active)
            throw new Error(`Cannot lower the maximum below ${active} active run(s)`);
        },
      }),
    isCurrent: () => ext.runtime?.generation === ext.generation && ext.runtime?.manager === manager,
  });
}

async function startSession(pi, ext, ctx, indicator) {
  if (ext.pendingShutdowns.size) {
    try {
      await cleanupPending(ext);
    } catch (error) {
      // Never restore a still-running worker as an interrupted, cancelled run.
      retire(ext);
      throw new Error(`Subagents cannot start while previous process cleanup is unresolved: ${error.message}`, {
        cause: error,
      });
    }
  }
  ext.generation += 1;
  const generation = ext.generation;
  const runtime = createSubagentSession(pi, ctx, {
    options: ext,
    isCurrent: manager => ext.runtime?.manager === manager && ext.runtime.generation === ext.generation,
    deliveryEnabled: () => ext.runtime?.deliveryEnabled === true,
  });
  Object.assign(runtime, { generation, deliveryEnabled: true });
  ext.runtime = runtime;
  const entries = ctx.sessionManager.getBranch?.() ?? [];
  runtime.readRuns = readRunsOnBranch(entries);
  runtime.branchIds = branchIdsOf(runtime.branchId, entries);
  await restoreAgents(runtime, ctx);
  if (ctx.mode === 'tui') {
    runtime.ui = createUI(ext, ctx, indicator);
    await runtime.ui.ready;
  }
}

/**
 * The conversation has grown on the current branch since session start or `/tree`: its leaf
 * belongs to that branch, and agents started now are anchored to it, so leaving this point
 * stops them.
 */
function followLeaf(runtime, ctx) {
  const leaf = ctx.sessionManager.getLeafId?.();
  if (!leaf || leaf === runtime.branchId || !runtime.deliveryEnabled) return;
  runtime.branchIds.add(leaf);
  runtime.delivery.branchIds.add(leaf);
  runtime.manager.setBranchId(leaf, runtime.branchIds);
  runtime.branchId = leaf;
}

/** Moves delivery to the new branch; agents still running for the branch being left are stopped. */
async function switchBranch(runtime, ctx) {
  // Do not publish terminal events from the branch being left into the new tree context.
  runtime.deliveryEnabled = false;
  const branchId = ctx.sessionManager.getLeafId() ?? 'root';
  const nextBranchIds = branchIdsOf(branchId, ctx.sessionManager.getBranch?.() ?? []);
  await Promise.all(
    runtime.manager
      .activeAgentIds()
      .filter(agentId => !nextBranchIds.has(runtime.manager.getAgent(agentId).branchId))
      .map(agentId => runtime.manager.stop({ agentId }).catch(() => {})),
  );
  runtime.branchIds = nextBranchIds;
  runtime.readRuns = readRunsOnBranch(ctx.sessionManager.getBranch?.() ?? []);
  runtime.delivery.setBranchIds(runtime.branchIds);
  runtime.manager.setBranchId(branchId, runtime.branchIds);
  runtime.branchId = branchId;
  runtime.deliveryEnabled = true;
}

function registerSessionLifecycle(pi, ext, indicator) {
  pi.on('session_start', (_event, ctx) => startSession(pi, ext, ctx, indicator));

  pi.on('session_tree', async (_event, ctx) => {
    if (ext.runtime) await switchBranch(ext.runtime, ctx);
  });

  pi.on('session_shutdown', async (_event, _ctx) => {
    const previous = ext.runtime;
    if (previous) {
      previous.ui?.dispose();
      previous.ui = undefined;
      previous.deliveryEnabled = false;
      previous.dialogs.abort();
      ext.pendingShutdowns.add(previous);
    }
    await cleanupPending(ext);
    if (previous && ext.runtime === previous) retire(ext);
  });
}

/** Subagent state in the model context, pending result delivery, and the wait at agent end. */
function registerConversationHooks(pi, ext) {
  pi.on('before_agent_start', (event, _ctx) => {
    ext.lastPromptOptions = structuredClone(event.systemPromptOptions);
  });

  pi.on('context', (event, _ctx) => {
    const active = ext.runtime;
    if (!active) return undefined;
    active.delivery.observeContext(event.messages);
    const states = active.manager
      .compactAgents()
      .filter(agent => active.branchIds.has(agent.branchId))
      .map(summary);
    if (states.length === 0) return undefined;
    const reminders = active.delivery.contextReminders(active.manager.compactAgents());
    return {
      messages: [
        ...event.messages,
        {
          role: 'custom',
          customType: STATE_ENTRY,
          content: formatSubagentContext(states, active.branchIds, 20 * 1024),
          display: false,
          timestamp: Date.now(),
        },
        ...reminders,
      ],
    };
  });

  pi.on('agent_settled', () => {
    ext.runtime?.delivery.retryMissing();
  });

  // A parent agent cannot silently settle while active delegated work remains.
  pi.on('agent_end', async (_event, ctx) => {
    const manager = ext.runtime?.manager;
    if (manager && !ctx.signal?.aborted) await settleDelegatedWork(ext, manager, ctx.signal);
  });
}

/** Waits until `manager` has no active agent, is replaced, or `signal` aborts. */
async function settleDelegatedWork(ext, manager, signal) {
  const current = () => !signal?.aborted && ext.runtime?.manager === manager;
  while (current()) {
    const agentIds = manager.activeAgentIds();
    if (agentIds.length === 0) break;
    try {
      await manager.wait({ agentIds, mode: 'all', timeoutMs: 300_000, signal });
    } catch (error) {
      if (!current()) break;
      if (!/wait timed out/u.test(error.message)) throw error;
    }
  }
}

async function settingsCommand(ext, runtime, ctx) {
  if (ctx.mode === 'tui') return runtime.ui.settings();
  const config = await loadSubagentConfig({ path: ext.configPath });
  notify(ctx, `auto ${config.autoDelegate ? 'on' : 'off'}; max ${config.maxConcurrent}`);
}

function registerCommand(pi, ext) {
  pi.registerCommand('subagents', {
    description: 'Open the subagent interface; settings opens global user settings; list prints a summary.',
    handler: async (args, ctx) => {
      const [rawCommand, ...extra] = args.trim().split(/\s+/u);
      const command = rawCommand || 'list';
      if (!['list', 'settings'].includes(command) || extra.length) {
        notify(ctx, 'Usage: /subagents [list|settings]', 'warning');
        return;
      }
      const runtime = ext.runtime;
      if (!runtime?.manager) {
        notify(ctx, 'Subagents are not active for this session', 'warning');
        return;
      }
      if (command === 'settings') return settingsCommand(ext, runtime, ctx);
      // A bare /subagents opens the interface; /subagents list always prints.
      if (!rawCommand && ctx.mode === 'tui') return runtime.ui.open();
      const items = runtime.manager
        .compactAgents()
        .map(agent => `${agent.alias} ${agent.run?.state ?? 'idle'} — ${agent.title}`)
        .join('\n');
      notify(ctx, items || 'No subagents.');
    },
  });
}
