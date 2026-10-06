export default function childDialog(pi) {
  pi.registerCommand('subagent-dialog-fixture', {
    description: 'Test-only child dialog fixture',
    handler: async () => {},
  });
  pi.on('before_agent_start', async (event, ctx) => {
    if (event.prompt?.includes('WAIT_FOR_DIALOG')) {
      const approved = await ctx.ui.confirm('Child permission', 'Allow the delegated dialog?', { timeout: 5_000 });
      if (!approved) return { systemPrompt: `${event.systemPrompt}\nCHILD_DIALOG_DECLINED` };
    }
  });
}
