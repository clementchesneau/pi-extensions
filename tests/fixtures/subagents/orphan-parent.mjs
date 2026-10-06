import { createSubagentRuntime } from '../../../packages/subagents/runtime.js';

process.once('message', async ({ bootstrap, options }) => {
  const runtime = createSubagentRuntime(bootstrap, options);
  await runtime.start();
  process.send?.({ workerPid: runtime.pid });
  setImmediate(() => process.exit(0));
});
