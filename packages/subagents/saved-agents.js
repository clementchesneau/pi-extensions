import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { ACTIVE_STATES, now, TRANSITIONS } from './run-state.js';

// Fields a restored agent relies on; other saved fields are kept as they are.
const SavedAgent = Type.Object({
  alias: Type.String({ pattern: '^A[1-9]\\d*$' }),
  branchId: Type.String({ minLength: 1 }),
  title: Type.String(),
  runs: Type.Array(
    Type.Object({
      runId: Type.String({ minLength: 1 }),
      state: Type.Union(Object.keys(TRANSITIONS).map(state => Type.Literal(state))),
      instructions: Type.Optional(Type.Union([Type.Null(), Type.Array(Type.String())])),
    }),
  ),
});

/** Alias number of saved agent metadata; throws when the metadata is unusable. */
export function savedAliasNumber(serialized) {
  const aliasNumber = Number(/^A(\d+)$/u.exec(serialized.alias)?.[1]);
  if (!Value.Check(SavedAgent, serialized) || !Number.isSafeInteger(aliasNumber))
    throw new Error(`Invalid saved subagent metadata for ${serialized.agentId}`);
  return aliasNumber;
}

/** Live copy of saved metadata; runs that were in progress are recorded as interrupted. */
export function restoredAgent(serialized) {
  const agent = structuredClone(serialized);
  agent.runtime = undefined;
  agent.restored = true;
  agent.sequence = Number.isSafeInteger(agent.sequence) ? agent.sequence : 0;
  agent.runs ??= [];
  for (const run of agent.runs) {
    // Older archives did not record run instructions; do not infer missing history.
    run.instructions ??= [];
    delete run.completion;
    delete run.runtime;
    if (ACTIVE_STATES.has(run.state) || run.state === 'awaiting_confirmation') {
      run.state = 'cancelled';
      run.error = 'Subagent run interrupted by session restoration';
      run.activity = 'interrupted';
      run.finishedAt ??= now();
    }
  }
  return agent;
}
