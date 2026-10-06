// In-memory record of a session's subagents: identities, aliases, visible branches and runs.
import { randomUUID } from 'node:crypto';
import { ACTIVE_STATES, compactAgent, compactRun, publicAgent } from './run-state.js';
import { restoredAgent, savedAliasNumber } from './saved-agents.js';

export function assertAgentInput({ title, task, context }) {
  if (
    typeof title !== 'string' ||
    !title.trim() ||
    typeof task !== 'string' ||
    !task.trim() ||
    typeof context !== 'string'
  )
    throw new TypeError('title, task and context must be non-empty strings');
}

export class AgentRegistry {
  #agents = new Map();
  #alias = 0;
  #branchIds;

  constructor(branchIds) {
    this.#branchIds = new Set(branchIds);
  }

  /** Branches whose agents the current session may address. */
  setBranchIds(branchIds) {
    this.#branchIds = new Set(branchIds);
  }

  /** Adds saved agents of `ownerSessionId` that are not known yet. */
  restore(agents, ownerSessionId) {
    for (const serialized of agents) {
      if (
        !serialized ||
        serialized.ownerSessionId !== ownerSessionId ||
        !serialized.agentId ||
        this.#agents.has(serialized.agentId)
      )
        continue;
      const aliasNumber = savedAliasNumber(serialized);
      const agent = restoredAgent(serialized);
      this.#alias = Math.max(this.#alias, aliasNumber);
      this.#agents.set(agent.agentId, agent);
    }
  }

  /** Registers a new agent under the next alias; `assertAgentInput` has accepted its fields. */
  add({ ownerSessionId, branchId, title, task, context, ...settings }) {
    const { capabilitySnapshot, privateCapabilities, model, thinkingLevel, tools, selectionSource } = settings;
    const agent = {
      agentId: randomUUID(),
      alias: `A${++this.#alias}`,
      ownerSessionId,
      branchId,
      title: title.trim(),
      task,
      context,
      capabilitySnapshot,
      privateCapabilities,
      model,
      thinkingLevel,
      tools,
      selectionSource,
      sequence: 0,
      runs: [],
      runtime: undefined,
    };
    this.#agents.set(agent.agentId, agent);
    return agent;
  }

  all() {
    return [...this.#agents.values()];
  }

  get(agentId) {
    const agent = this.#agents.get(agentId);
    if (!agent) throw new Error(`Unknown subagent ${agentId}`);
    return agent;
  }

  /** Agent by exact identifier or alias, if any. */
  lookup(agentId) {
    return this.#agents.get(agentId) ?? this.all().find(value => value.alias === agentId);
  }

  /** Public view of the agent with this identifier or alias (case-insensitive), if any. */
  find(id) {
    const agent = this.all().find(
      candidate => candidate.agentId === id || candidate.alias.toLowerCase() === id?.toLowerCase(),
    );
    return agent ? publicAgent(agent) : undefined;
  }

  assertCurrentBranch(agentId) {
    const agent = this.get(agentId);
    if (!this.#branchIds.has(agent.branchId)) throw new Error(`Subagent ${agent.alias} belongs to another branch`);
    return agent;
  }

  /** @param {{agentId?: string, cursor?: number, limit?: number}} [options] */
  list({ agentId, cursor = 0, limit = 50 } = {}) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError('Invalid list cursor or limit');
    if (agentId !== undefined) {
      const agent = this.get(agentId);
      const items = agent.runs
        .slice(cursor, cursor + limit)
        .map(({ runId, state, startedAt, finishedAt }) => ({ runId, state, startedAt, finishedAt }));
      return { agentId, items, nextCursor: cursor + limit < agent.runs.length ? cursor + limit : undefined };
    }
    const items = this.all().map(agent => ({
      agentId: agent.agentId,
      alias: agent.alias,
      branchId: agent.branchId,
      title: agent.title,
      runCount: agent.runs.length,
      run: compactRun(agent.runs.at(-1)),
    }));
    return {
      items: items.slice(cursor, cursor + limit),
      nextCursor: cursor + limit < items.length ? cursor + limit : undefined,
    };
  }

  compact() {
    return this.all().map(agent => compactAgent(agent));
  }

  activeIds() {
    return this.all()
      .filter(agent => agent.runs.some(run => ACTIVE_STATES.has(run.state)))
      .map(agent => agent.agentId);
  }

  /** Runs holding a concurrency slot, across all agents. */
  activeRunCount() {
    return this.all()
      .flatMap(agent => agent.runs)
      .filter(run => ACTIVE_STATES.has(run.state)).length;
  }

  /** Latest run of each agent (all agents by default), or the exact `runIds` aligned with `agentIds`. */
  selectRuns(agentIds, runIds) {
    if (
      runIds !== undefined &&
      (!Array.isArray(agentIds) || !Array.isArray(runIds) || runIds.length !== agentIds.length)
    ) {
      throw new TypeError('runIds must match agentIds in length and order');
    }
    return (agentIds ?? [...this.#agents.keys()])
      .map((id, index) => {
        const agent = this.get(id);
        if (runIds === undefined) return agent.runs.at(-1);
        const run = agent.runs.find(candidate => candidate.runId === runIds[index]);
        if (!run) throw new Error(`Unknown run ${runIds[index]} for subagent ${agent.alias}`);
        return run;
      })
      .filter(Boolean);
  }
}
