import { writeFileSync } from 'node:fs';

// Runs before the subagents extension. The marker is written only when the real
// print/JSON parent enters agent_end, immediately before its delegation barrier.
export default function barrierObserver(pi) {
  pi.on('agent_end', (_event, ctx) => {
    if (ctx.mode === 'print' || ctx.mode === 'json') {
      writeFileSync(process.env.SUBAGENT_TEST_BARRIER_MARKER, 'entered');
    }
  });
}
