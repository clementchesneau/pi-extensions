import assert from 'node:assert/strict';
import test from 'node:test';
import { searchWeb } from '../packages/web/search.js';

test('searches Brave once and returns bounded, attributable web results', async () => {
  const calls = [];
  const result = await searchWeb(
    { query: 'Node.js docs', count: 2, freshness: 'pw', language: 'fr' },
    {
      apiKey: 'test-secret',
      request: async (url, options) => {
        calls.push({ url: new URL(url), options });
        return {
          status: 200,
          body: JSON.stringify({
            web: {
              results: [
                {
                  title: 'Node.js',
                  url: 'https://nodejs.org/en/docs',
                  description: 'Documentation',
                  age: '2 days ago',
                },
                { title: 'Unsafe', url: 'javascript:alert(1)', description: 'Ignore' },
                { title: 'Other', url: 'https://example.com', description: 'More docs' },
              ],
            },
          }),
        };
      },
    },
  );
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(url.searchParams.get('q'), 'Node.js docs');
  assert.equal(url.searchParams.get('count'), '2');
  assert.equal(url.searchParams.get('freshness'), 'pw');
  assert.equal(url.searchParams.get('search_lang'), 'fr');
  assert.equal(url.searchParams.get('text_decorations'), 'false');
  assert.equal(options.headers['X-Subscription-Token'], 'test-secret');
  assert.equal(options.maxRedirects, 0);
  assert.equal(result.provider, 'Brave Search');
  assert.deepEqual(result.results, [
    { title: 'Node.js', url: 'https://nodejs.org/en/docs', snippet: 'Documentation', age: '2 days ago' },
    { title: 'Other', url: 'https://example.com/', snippet: 'More docs' },
  ]);
  assert.ok(!JSON.stringify(result).includes('test-secret'));
});

test('validates inputs and missing keys without contacting Brave', async () => {
  const request = () => assert.fail('No request expected');
  for (const params of [
    { query: '' },
    { query: 'x'.repeat(401) },
    { query: 'x '.repeat(51) },
    { query: 'x', count: 1.5 },
    { query: 'x', count: 21 },
    { query: 'x', freshness: 'yesterday' },
    { query: 'x', language: 'invalid' },
  ]) {
    await assert.rejects(searchWeb(params, { apiKey: 'test', request }));
  }
  await assert.rejects(searchWeb({ query: 'x' }, { apiKey: '', request }), /BRAVE_API_KEY/);
});

test('reports empty results, malformed responses and API errors without retries or leaked bodies', async () => {
  const empty = await searchWeb({ query: 'x' }, { apiKey: 'test', request: async () => ({ status: 200, body: '{}' }) });
  assert.deepEqual(empty.results, []);
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(
      searchWeb(
        { query: 'x' },
        {
          apiKey: 'test',
          request: async () => {
            calls++;
            return { status, body: 'sensitive upstream response' };
          },
        },
      ),
      error => error.message.includes(String(status)) && !error.message.includes('sensitive'),
    );
    assert.equal(calls, 1);
  }
  for (const body of ['not json', 'null', '[]', '{"web":{}}', '{"error":"secret"}']) {
    await assert.rejects(
      searchWeb({ query: 'x' }, { apiKey: 'test', request: async () => ({ status: 200, body }) }),
      /JSON|unexpected/,
    );
  }
});

test('sanitizes transport failures and rejects invalid API key headers', async () => {
  await assert.rejects(
    searchWeb(
      { query: 'x' },
      {
        apiKey: 'test-secret',
        request: async () => {
          throw new Error('header contained test-secret');
        },
      },
    ),
    error => !String(error).includes('test-secret') && /network/i.test(error.message),
  );
  await assert.rejects(
    searchWeb({ query: 'x' }, { apiKey: 'secret\nheader', request: () => assert.fail('No request expected') }),
    /BRAVE_API_KEY/,
  );
});
