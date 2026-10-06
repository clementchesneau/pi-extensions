export default function deterministicProvider(pi) {
  console.log('deterministic provider loaded');
  const baseUrl = process.env.SUBAGENT_TEST_PROVIDER_URL;
  if (!baseUrl) throw new Error('SUBAGENT_TEST_PROVIDER_URL is required');
  pi.on('input', async (event, ctx) => {
    if (event.text.includes('HANDLE_IMMEDIATELY')) return { action: 'handled' };
    if (!event.text.includes('WAIT_FOR_DIALOG')) return { action: 'continue' };
    await ctx.ui.confirm('Deterministic wait', 'Waiting for cancellation', { signal: ctx.signal, timeout: 30_000 });
    return { action: 'handled' };
  });
  pi.registerProvider('subagent-test', {
    name: 'Subagent deterministic test provider',
    baseUrl,
    apiKey: 'local-test-key',
    api: 'openai-completions',
    models: ['deterministic', 'deterministic-b', 'deterministic-image'].map(id => ({
      id,
      name:
        id === 'deterministic' ? 'Deterministic' : id === 'deterministic-b' ? 'Deterministic B' : 'Deterministic image',
      reasoning: false,
      input: id === 'deterministic-image' ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_384,
      maxTokens: 1_024,
    })),
  });
}
