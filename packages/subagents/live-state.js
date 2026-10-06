import { updateAssistantMessage } from './assistant-stream.js';

// Display state is deliberately separate from persisted agent metadata. Keep whole
// recent records (never a truncated JSON prefix); older records remain in the archive.
const MAX_MESSAGES = 128;
const MAX_TOOLS = 128;
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
const COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'];

export function addUsage(left, right) {
  if (!left) return right ? structuredClone(right) : undefined;
  if (!right) return structuredClone(left);
  const result = {};
  for (const field of FIELDS) {
    if (Number.isFinite(left[field]) && Number.isFinite(right[field])) result[field] = left[field] + right[field];
  }
  result.cost = {};
  for (const field of COST_FIELDS) {
    if (Number.isFinite(left.cost?.[field]) && Number.isFinite(right.cost?.[field]))
      result.cost[field] = left.cost[field] + right.cost[field];
  }
  return result;
}

function confirmedUsage(left, right) {
  if (!left) return right;
  if (!right) return left;
  // RPC stats can arrive after a later message_end. Counters within one run
  // are monotonic, so a delayed sample must not roll the display backwards.
  const result = { cost: {} };
  for (const field of FIELDS) {
    const values = [left[field], right[field]].filter(Number.isFinite);
    if (values.length) result[field] = Math.max(...values);
  }
  for (const field of COST_FIELDS) {
    const values = [left.cost?.[field], right.cost?.[field]].filter(Number.isFinite);
    if (values.length) result.cost[field] = Math.max(...values);
  }
  return result;
}

/** Counters of `values` beyond `included`, for each one known on both sides (or with nothing included). */
function excessCounters(values, included, fields) {
  const extra = {};
  for (const field of fields) {
    if (Number.isFinite(values?.[field]) && (!included || Number.isFinite(included[field]))) {
      extra[field] = Math.max(0, values[field] - (included?.[field] ?? 0));
    }
  }
  return extra;
}

function excessUsage(usage, included) {
  const extra = { cost: {} };
  Object.assign(extra, excessCounters(usage, included, FIELDS));
  extra.cost = excessCounters(usage.cost, included && (included.cost ?? {}), COST_FIELDS);
  return extra;
}

// Completed assistant usage overlaps RPC totals. Preserve only the sampled
// excess (tools/compaction), then add later messages rather than taking a max
// between overlapping totals and losing each newly completed message.
export class RunUsage {
  confirmed;
  extra;
  #sampled;

  get sampled() {
    return this.#sampled;
  }
  set sampled(usage) {
    this.sample(usage);
  }

  sample(usage, included = this.confirmed) {
    if (!usage) return;
    this.#sampled = structuredClone(usage);
    this.extra = confirmedUsage(this.extra, excessUsage(usage, included));
  }

  get usage() {
    return addUsage(this.confirmed, this.extra);
  }
}

export class LiveSubagentState extends RunUsage {
  messages = [];
  message;
  tools = new Map();
  historyBytes = 0;
  toolBytes = new Map();
  toolHistoryBytes = 0;
  discarded = false;

  get usage() {
    return addUsage(super.usage, this.message?.usage);
  }

  update(data) {
    if (data.type === 'message_start' || data.type === 'message_update')
      this.message = updateAssistantMessage(this.message, data);
    if (data.type === 'message_end' && data.message) this.#recordMessage(structuredClone(data.message));
    if (data.type.startsWith('tool_execution_') && data.toolCallId) this.#recordTool(data);
    while (this.tools.size > MAX_TOOLS || (this.tools.size > 1 && this.toolHistoryBytes > MAX_HISTORY_BYTES)) {
      const oldest = [...this.tools].find(([, tool]) => tool.finished) ?? this.tools.entries().next().value;
      this.tools.delete(oldest[0]);
      this.toolHistoryBytes -= this.toolBytes.get(oldest[0]) ?? 0;
      this.toolBytes.delete(oldest[0]);
      this.discarded = true;
    }
  }

  #recordMessage(message) {
    if (message.role === 'assistant') {
      this.confirmed = addUsage(this.confirmed, message.usage);
      this.message = undefined;
    }
    const bytes = Buffer.byteLength(JSON.stringify(message));
    this.messages.push({ message, bytes });
    this.historyBytes += bytes;
    while (this.messages.length > MAX_MESSAGES || (this.messages.length > 1 && this.historyBytes > MAX_HISTORY_BYTES)) {
      this.historyBytes -= this.messages.shift().bytes;
      this.discarded = true;
    }
  }

  #recordTool(data) {
    const id = data.toolCallId;
    const tool = this.tools.get(id) ?? { toolCallId: id, toolName: data.toolName, args: {} };
    if (data.type === 'tool_execution_start') {
      this.tools.set(id, {
        toolCallId: id,
        toolName: data.toolName,
        args: structuredClone(data.args ?? {}),
        finished: false,
      });
    } else if (data.type === 'tool_execution_update') {
      this.tools.set(id, { ...tool, result: structuredClone(data.partialResult), isPartial: true, finished: false });
    } else if (data.type === 'tool_execution_end') {
      this.tools.set(id, {
        ...tool,
        result: structuredClone(data.result),
        isPartial: false,
        finished: true,
        isError: data.isError,
      });
    }
    if (!this.tools.has(id)) return;
    const bytes = Buffer.byteLength(JSON.stringify(this.tools.get(id)));
    this.toolHistoryBytes += bytes - (this.toolBytes.get(id) ?? 0);
    this.toolBytes.set(id, bytes);
  }

  snapshot(runId) {
    return structuredClone({
      runId,
      messages: this.messages.map(entry => entry.message),
      message: this.message,
      tools: [...this.tools.values()],
      discarded: this.discarded,
    });
  }
}
