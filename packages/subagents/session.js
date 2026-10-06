import { loadSubagentConfig } from './config.js';
import { ResultDelivery } from './delivery.js';
import { createDialogBridge } from './dialog-bridge.js';
import { SubagentManager } from './manager.js';
import { SubagentStore } from './store.js';

export const STATE_ENTRY = 'subagents-state-v1';
const LAUNCH_CONFIRMATION_TIMEOUT_MS = 30_000;

export function summary(agent) {
  return {
    agentId: agent.agentId,
    alias: agent.alias,
    branchId: agent.branchId,
    title: agent.title,
    runCount: agent.runs.length,
    runs: agent.runs
      .slice(-10)
      .map(run => ({ runId: run.runId, state: run.state, activity: run.activity, finishedAt: run.finishedAt })),
  };
}

export function notify(ctx, message, type = 'info') {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

function confirmLaunch(pi, ctx, deliveryEnabled) {
  /** @param {{ agent: any, run: any }} request @param {{ signal?: AbortSignal }} [options] */
  return async ({ agent, run }, { signal } = {}) => {
    if (!ctx.hasUI) throw new Error('Subagent confirmation is unavailable without a capable UI');
    if (ctx.mode === 'tui' && deliveryEnabled())
      pi.appendEntry('subagents-event-v1', {
        agentId: agent.agentId,
        alias: agent.alias,
        title: agent.title,
        branchId: agent.branchId,
        state: 'confirmation requested',
      });
    return ctx.ui.confirm(
      `Start ${agent.alias}: ${agent.title}?`,
      `Mission:\n${agent.task}\n\nSelected context:\n${agent.context}\n\nRun ${run.runId}`,
      {
        timeout: LAUNCH_CONFIRMATION_TIMEOUT_MS,
        signal: ctx.signal ? AbortSignal.any([ctx.signal, signal]) : signal,
      },
    );
  };
}

function workerFactory({ store, ownerSessionId, options }) {
  const { agentDir, createRuntime, hostRuntime, loadRuntime } = options;
  return async agent => {
    const piRuntime = hostRuntime();
    await loadRuntime(piRuntime);
    const path = await store.ensureAgentDirectory(agent.agentId);
    const snapshot = agent.capabilitySnapshot;
    return createRuntime({
      version: 1,
      piRuntime,
      instanceId: agent.agentId,
      parentSessionId: ownerSessionId,
      cwd: snapshot.cwd,
      agentDir,
      model: agent.model,
      thinkingLevel: agent.thinkingLevel,
      allowedTools: agent.tools,
      resources: { extensionPaths: [], skillPaths: [], promptTemplatePaths: [], contextFiles: false },
      capabilitySnapshot: snapshot,
      privateCapabilities: agent.privateCapabilities,
      sessionDir: path,
      sessionFile: agent.runs.findLast(run => run.sessionFile)?.sessionFile,
    });
  };
}

/**
 * Subagents of one parent session: their store, manager, result delivery and dialog relay.
 * `isCurrent(manager)` tells whether this session still owns the extension, and
 * `deliveryEnabled()` whether results may be published on the current branch.
 */
export function createSubagentSession(pi, ctx, { options, isCurrent, deliveryEnabled }) {
  const ownerSessionId = ctx.sessionManager.getSessionId();
  const branchId = ctx.sessionManager.getLeafId() ?? 'root';
  const store = new SubagentStore({
    agentDir: options.agentDir,
    ownerSessionId,
    ephemeral: ctx.sessionManager.isPersisted?.() === false,
  });
  const branchEntries = ctx.sessionManager.getBranch?.() ?? [];
  const branchIds = new Set([branchId, ...branchEntries.map(entry => entry.id)]);
  const delivery = new ResultDelivery({ pi, ctx, branchIds, entries: branchEntries });
  const dialogs = createDialogBridge({ ctx, notify, timeoutMs: options.dialogTimeoutMs });
  const announce = (agent, run) => {
    if (!deliveryEnabled() || !run) return;
    try {
      delivery.announce(agent, run, { preview: run.resultPreview ?? run.result?.slice(0, 240) });
    } catch (error) {
      notify(ctx, `Subagent result notification remains pending: ${error.message}`, 'warning');
    }
    if (run.error) notify(ctx, `${agent.alias}: ${run.error}`, 'warning');
  };
  const manager = new SubagentManager({
    ownerSessionId,
    branchId,
    getConfig: () => loadSubagentConfig({ path: options.configPath }),
    persist: agent => store.saveAgent(agent),
    saveResult: (agent, run, text) => store.saveResult(agent.agentId, run.runId, text),
    readResult: (agent, run, readOptions) => store.readResult(agent.agentId, run.runId, readOptions),
    readTranscript: (agent, readOptions) => store.readTranscript(agent.agentId, readOptions),
    handleUiRequest: dialogs.handleUiRequest,
    confirm: confirmLaunch(pi, ctx, deliveryEnabled),
    createRuntime: workerFactory({ store, ownerSessionId, options }),
  });
  const session = { manager, store, ownerSessionId, branchId, branchIds, announce, delivery, dialogs };
  manager.subscribe(event => {
    if (!isCurrent(manager)) return;
    if (deliveryEnabled() && session.branchIds.has(event.agent.branchId)) {
      pi.appendEntry(STATE_ENTRY, {
        version: 1,
        ownerSessionId,
        branchId: event.agent.branchId,
        agent: summary(event.agent),
      });
    }
    announce(
      event.agent,
      event.agent.runs.find(item => item.runId === event.runId),
    );
  });
  return session;
}
