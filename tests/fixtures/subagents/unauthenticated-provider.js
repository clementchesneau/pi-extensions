export default function unauthenticatedProvider(pi) {
  pi.registerProvider('subagent-unauthenticated', {
    name: 'Unauthenticated fixture',
    baseUrl: 'https://example.invalid/v1',
    apiKey: '$SUBAGENT_INTENTIONALLY_MISSING_KEY',
    api: 'openai-completions',
    models: [
      {
        id: 'missing-auth',
        name: 'Missing auth',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
      },
    ],
  });
}
