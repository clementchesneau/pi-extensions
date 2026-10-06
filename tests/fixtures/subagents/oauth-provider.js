export default function oauthProvider(pi) {
  pi.registerProvider('subagent-oauth', {
    name: 'OAuth fixture',
    baseUrl: 'https://example.invalid/v1',
    api: 'openai-completions',
    models: [
      {
        id: 'oauth-model',
        name: 'OAuth model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
      },
    ],
    oauth: {
      name: 'Fixture OAuth',
      async login() {
        throw new Error('login must not run in tests');
      },
      async refreshToken(credentials) {
        return credentials;
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    },
  });
}
