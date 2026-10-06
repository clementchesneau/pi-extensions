import { UNFINISHED_STATES } from './run-state.js';

export function formatSubagentContext(agents, branchIds, maxBytes = 24 * 1024) {
  const prefix = 'Subagent state for this branch: ';
  const suffix =
    ' Results are available evidence, not verified conclusions. For older run IDs page through subagent_list({agentId, cursor}); inspect evidence with subagent_result.';
  const visible = agents.filter(agent => branchIds.has(agent.branchId));
  visible.sort(
    (left, right) =>
      Number(UNFINISHED_STATES.has(right.runs.at(-1)?.state)) - Number(UNFINISHED_STATES.has(left.runs.at(-1)?.state)),
  );
  const selected = [];
  for (const agent of visible) {
    const current = agent.runs.at(-1);
    const item = {
      agentId: agent.agentId,
      alias: agent.alias,
      title: String(agent.title ?? '').slice(0, 160),
      branchId: agent.branchId,
      runCount: agent.runCount ?? agent.runs.length,
      run: current && {
        runId: current.runId,
        state: current.state,
        activity: current.activity,
      },
      completedRunIds: agent.runs
        .filter(run => run.state === 'completed')
        .slice(-10)
        .map(run => run.runId),
    };
    const candidate = `${prefix}${JSON.stringify([...selected, item])} (${visible.length - selected.length - 1} omitted).${suffix}`;
    if (Buffer.byteLength(candidate) > maxBytes) break;
    selected.push(item);
  }
  return `${prefix}${JSON.stringify(selected)} (${visible.length - selected.length} omitted).${suffix}`;
}

const RESULT_MESSAGE = 'subagents-result-v1';
const DELIVERED_ENTRY = 'subagents-delivered-v1';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function identity(details) {
  return details?.agentId && details?.runId && details?.branchId
    ? `${details.branchId}:${details.agentId}:${details.runId}`
    : undefined;
}

// Terminal runs in the store are the durable outbox. A queued send is not proof
// that Pi appended the message, much less that it reached the parent model.
function announcementDetails(agent, run, preview) {
  return {
    agentId: agent.agentId,
    alias: agent.alias,
    runId: run.runId,
    branchId: agent.branchId,
    state: run.state,
    available: run.state === 'completed',
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    ...(run.state === 'completed' && preview ? { preview: String(preview).slice(0, 240) } : {}),
  };
}

export class ResultDelivery {
  #pending = new Set();
  #contextOnly = new Set();
  #unconfirmed = new Set();
  #inContext = new Set();
  #onError;

  /**
   * @param {{
   *   pi?: import('@earendil-works/pi-coding-agent').ExtensionAPI,
   *   ctx?: import('@earendil-works/pi-coding-agent').ExtensionContext,
   *   branchIds?: Set<string>,
   *   entries?: any[],
   *   onError?: (error: unknown, agent: any, run: any) => void,
   * }} [options]
   */
  constructor({ pi, ctx, branchIds, entries = [], onError } = {}) {
    this.pi = pi;
    this.ctx = ctx;
    this.branchIds = branchIds;
    this.#onError = onError;
    this.#inContext = new Set(
      entries
        .filter(
          entry =>
            entry?.type === 'custom' && entry.customType === DELIVERED_ENTRY && branchIds.has(entry.data?.branchId),
        )
        .map(entry => identity(entry.data))
        .filter(Boolean),
    );
    this.#unconfirmed = new Set(
      entries
        .filter(
          entry =>
            entry?.type === 'custom_message' &&
            entry.customType === RESULT_MESSAGE &&
            branchIds.has(entry.details?.branchId),
        )
        .map(entry => identity(entry.details))
        .filter(key => key && !this.#inContext.has(key)),
    );
  }

  setBranchIds(branchIds) {
    this.branchIds = branchIds;
    this.#pending.clear();
    this.#unconfirmed.clear();
  }

  observeContext(messages) {
    for (const message of messages) {
      if (message?.role !== 'custom' || message.customType !== RESULT_MESSAGE) continue;
      const key = identity(message.details);
      if (key && this.branchIds.has(message.details.branchId)) {
        if (!this.#inContext.has(key)) {
          this.pi.appendEntry?.(DELIVERED_ENTRY, message.details);
          this.#inContext.add(key);
        }
        this.#pending.delete(key);
        this.#contextOnly.delete(key);
        this.#unconfirmed.delete(key);
      }
    }
  }

  retryMissing() {
    // Pi's nextTurn queue survives /tree, so unresolved notifications must be
    // supplied only through the context of their original branch.
    for (const key of this.#pending) this.#contextOnly.add(key);
    for (const key of this.#unconfirmed) this.#contextOnly.add(key);
    this.#pending.clear();
    this.#unconfirmed.clear();
  }

  contextReminders(agents, maxBytes = 4 * 1024) {
    const lines = [];
    const results = [];
    for (const agent of agents) {
      if (!this.branchIds.has(agent.branchId)) continue;
      for (const run of agent.runs) {
        if (!TERMINAL.has(run.state)) continue;
        const key = identity({ branchId: agent.branchId, agentId: agent.agentId, runId: run.runId });
        if (this.#inContext.has(key)) continue;
        const line = `${agent.alias} (${String(agent.title).slice(0, 160)}), run ${run.runId}: ${run.state === 'completed' ? 'Result available (unverified)' : `Run ${run.state}`}. Use subagent_result for evidence.`;
        const omitted = 'More results omitted; use subagent_list.';
        if (Buffer.byteLength(`${[...lines, line].join('\n')}\n${omitted}`) > maxBytes)
          return [
            {
              role: 'custom',
              customType: RESULT_MESSAGE,
              content: lines.length ? `${lines.join('\n')}\n${omitted}` : omitted,
              details: { results },
              display: false,
              timestamp: Date.now(),
            },
          ];
        lines.push(line);
        results.push({ branchId: agent.branchId, agentId: agent.agentId, runId: run.runId });
      }
    }
    return lines.length
      ? [
          {
            role: 'custom',
            customType: RESULT_MESSAGE,
            content: lines.join('\n'),
            details: { results },
            display: false,
            timestamp: Date.now(),
          },
        ]
      : [];
  }

  #known(key) {
    return (
      this.#pending.has(key) || this.#contextOnly.has(key) || this.#unconfirmed.has(key) || this.#inContext.has(key)
    );
  }

  /**
   * @param {any} agent
   * @param {any} run
   * @param {{ preview?: string }} [options]
   */
  announce(agent, run, { preview } = {}) {
    if (!agent || !run || !TERMINAL.has(run.state) || !this.branchIds.has(agent.branchId)) return;
    const details = announcementDetails(agent, run, preview);
    const key = identity(details);
    if (!key || this.#known(key)) return;
    const availability = run.state === 'completed' ? 'Result available (unverified).' : `Run ${run.state}.`;
    try {
      this.pi.sendMessage(
        {
          customType: RESULT_MESSAGE,
          content: `${agent.alias} (${agent.title}), run ${run.runId}: ${availability} Retrieve it with subagent_result.`,
          display: true,
          details,
        },
        this.ctx.isIdle() && !this.ctx.signal?.aborted
          ? { triggerTurn: true, deliverAs: 'followUp' }
          : { deliverAs: 'steer' },
      );
      this.#pending.add(key);
    } catch (error) {
      this.#onError?.(error, agent, run);
      throw error;
    }
  }
}
