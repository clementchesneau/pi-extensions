export default function switchModel(pi) {
  pi.on('before_agent_start', async (_event, ctx) => {
    const replacement = ctx.modelRegistry.find('subagent-test', 'deterministic-b');
    if (!replacement) throw new Error('deterministic-b fixture model is unavailable');
    if (!(await pi.setModel(replacement))) throw new Error('deterministic-b fixture model has no authentication');
  });
}
