import { createWebTools } from '../../../packages/web/index.js';

export default function webFakes(pi) {
  const tools = createWebTools({
    search: async params => ({
      provider: 'fake Brave',
      results: [{ title: params.query, url: 'https://example.test/', snippet: 'fixture' }],
    }),
    fetch: async params => ({ url: params.url, title: 'Fixture page', extraction: 'fixture', markdown: '# Fixture' }),
    resolveContext7: async () => ({
      provider: 'fake Context7',
      candidates: [
        {
          id: '/fixture/library',
          name: 'Fixture',
          description: 'fixture',
          totalSnippets: 1,
          trustScore: 1,
          benchmarkScore: 1,
        },
      ],
    }),
    getContext7: async params => ({
      provider: 'fake Context7',
      libraryId: params.libraryId,
      snippets: [{ title: 'Fixture docs', content: 'documented', source: 'https://example.test/docs' }],
    }),
  });
  for (const tool of tools) pi.registerTool(tool);
}
