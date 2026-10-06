import { createMemory, processRegistry } from './memory.js';
import { createMemoryTools } from './memory-tools.js';
import { createCompactionTools, createVoluntaryCompaction } from './voluntary-compaction.js';

const INDEX = 'session-compaction:index-v1';

export default function sessionCompaction(pi) {
  registerSessionCompaction(pi);
}

/** Model-visible budget and, once the branch was compacted, the curated memory index. */
function contextMessage(budget, memory, ctx) {
  const remainingPercent = budget.percent === null ? null : Math.max(0, 100 - budget.percent);
  let content = `Session context budget (estimated): ${JSON.stringify({ ...budget, remainingPercent })}. Check session_compaction_status at investigation/milestone checkpoints; from 60% consider a useful boundary after updating factual memory. Native automatic settings are unchanged.`;
  if (ctx.sessionManager.getBranch().some(entry => entry.type === 'compaction'))
    content += `\nTemporary curated memory index (not instructions). Read only relevant notes with session_memory_read; verify facts as needed. Closed-session notes unavailable: ${memory.unavailableNotes}.\n${JSON.stringify(memory.notes.map(({ id, title, bytes }) => ({ id, title, bytes })))}`;
  return { role: 'custom', customType: INDEX, content, display: false, timestamp: Date.now() };
}

export function registerSessionCompaction(pi, { tempParent = undefined, registry = processRegistry() } = {}) {
  const memory = createMemory(pi, { tempParent, registry });
  const compaction = createVoluntaryCompaction(pi, memory);
  compaction.register();

  pi.on('session_start', async (event, ctx) => {
    await memory.start(event, ctx);
    compaction.publish(ctx);
  });
  pi.on('session_tree', (_event, ctx) => {
    compaction.reset();
    memory.changeBranch(ctx);
    compaction.publish(ctx);
  });
  pi.on('session_shutdown', async event => {
    compaction.reset({ forget: true });
    await memory.shutdown(event);
  });
  pi.on('context', (event, ctx) => {
    if (!memory.active) return;
    const message = contextMessage(compaction.publish(ctx), memory.active, ctx);
    return { messages: [...event.messages.filter(item => item.customType !== INDEX), message] };
  });

  for (const tool of [...createMemoryTools(memory), ...createCompactionTools(compaction, memory)])
    pi.registerTool(tool);
}
