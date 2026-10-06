import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { CONTEXT7_TIMEOUT_MS, getContext7Docs, resolveContext7Library } from '../packages/web/context7.js';

const key = 'ctx7sk-test-key';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('resolve performs one SDK request and preserves candidates, scores and versions', async () => {
  let calls = 0;
  const signal = new AbortController().signal;
  const result = await resolveContext7Library(
    { libraryName: 'react', query: 'hooks API' },
    {
      signal,
      readKey: async () => key,
      fetch: async (url, options) => {
        calls += 1;
        assert.equal(options.signal.aborted, false);
        assert.equal(new URL(url).pathname, '/api/v2/libs/search');
        assert.equal(new URL(url).searchParams.get('query'), 'hooks API');
        assert.equal(new URL(url).searchParams.get('libraryName'), 'react');
        assert.equal(options.headers.Authorization, `Bearer ${key}`);
        return jsonResponse({
          results: [
            {
              id: '/facebook/react',
              title: 'React',
              description: 'UI library',
              totalSnippets: 12,
              trustScore: 9,
              benchmarkScore: 88.5,
              versions: ['v19.1.0'],
            },
          ],
        });
      },
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    provider: 'Context7',
    candidates: [
      {
        id: '/facebook/react',
        name: 'React',
        description: 'UI library',
        totalSnippets: 12,
        trustScore: 9,
        benchmarkScore: 88.5,
        versions: ['v19.1.0'],
      },
    ],
  });
});

test('forces manual redirect handling so one invocation emits one real HTTP request', async t => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    if (requests === 1) {
      response.writeHead(302, { location: '/redirected' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ results: [] }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();

  await assert.rejects(
    resolveContext7Library(
      { libraryName: 'react', query: 'hooks' },
      {
        readKey: async () => key,
        fetch: (_url, init) => fetch(`http://127.0.0.1:${port}/api/v2/libs/search`, init),
      },
    ),
    /failed/i,
  );
  assert.equal(requests, 1);
});

test('docs performs one SDK request and preserves attributed snippets', async () => {
  let calls = 0;
  const signal = new AbortController().signal;
  const result = await getContext7Docs(
    { libraryId: '/facebook/react/v19.1.0', query: 'useEffect cleanup' },
    {
      signal,
      readKey: async () => key,
      fetch: async (url, options) => {
        calls += 1;
        assert.equal(options.signal.aborted, false);
        const parsed = new URL(url);
        assert.equal(parsed.pathname, '/api/v2/context');
        assert.equal(parsed.searchParams.get('query'), 'useEffect cleanup');
        assert.equal(parsed.searchParams.get('libraryId'), '/facebook/react/v19.1.0');
        assert.equal(parsed.searchParams.get('type'), 'json');
        return jsonResponse({
          codeSnippets: [],
          infoSnippets: [
            {
              breadcrumb: 'useEffect',
              content: 'Return a cleanup function.',
              pageId: 'https://react.dev/reference/react/useEffect',
            },
          ],
        });
      },
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    provider: 'Context7',
    libraryId: '/facebook/react/v19.1.0',
    snippets: [
      {
        title: 'useEffect',
        content: 'Return a cleanup function.',
        source: 'https://react.dev/reference/react/useEffect',
      },
    ],
  });
});

test('invalid input, missing keys and pre-aborted signals make no request', async () => {
  let calls = 0;
  const options = {
    readKey: async () => key,
    fetch: async () => {
      calls += 1;
    },
  };
  await assert.rejects(resolveContext7Library({ libraryName: '', query: 'x' }, options), /libraryName/);
  await assert.rejects(getContext7Docs({ libraryId: 'not-an-id', query: 'x' }, options), /libraryId/);
  await assert.rejects(resolveContext7Library({ libraryName: 'x', query: ' '.repeat(2) }, options), /query/);
  await assert.rejects(
    resolveContext7Library({ libraryName: 'x', query: 'x' }, { ...options, readKey: async () => '' }),
    /CONTEXT7_API_KEY/,
  );
  await assert.rejects(
    resolveContext7Library({ libraryName: 'x', query: 'x' }, { ...options, readKey: async () => '   ' }),
    /CONTEXT7_API_KEY/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    resolveContext7Library({ libraryName: 'x', query: 'x' }, { ...options, signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);
});

test('propagates cancellation and uses the explicit bounded timeout without retry', async () => {
  let calls = 0;
  const controller = new AbortController();
  let markStarted;
  const started = new Promise(resolve => {
    markStarted = resolve;
  });
  const pending = resolveContext7Library(
    { libraryName: 'react', query: 'hooks' },
    {
      signal: controller.signal,
      timeout: 25,
      readKey: async () => key,
      fetch: async (_url, options) => {
        calls += 1;
        assert.equal(options.signal.aborted, false);
        markStarted();
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }),
        );
      },
    },
  );
  await started;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(CONTEXT7_TIMEOUT_MS, 20_000);

  calls = 0;
  await assert.rejects(
    resolveContext7Library(
      { libraryName: 'react', query: 'hooks' },
      {
        timeout: 5,
        readKey: async () => key,
        fetch: async (_url, options) => {
          calls += 1;
          return new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }),
          );
        },
      },
    ),
    /timed out/i,
  );
  assert.equal(calls, 1);
});

test('maps authentication, quota, transport and malformed responses to safe errors', async () => {
  const sentinel = 'private-key-or-body';
  let responseCalls = 0;
  for (const [status, pattern] of [
    [401, /authentication/i],
    [403, /authentication/i],
    [429, /quota/i],
    [500, /failed/i],
  ]) {
    await assert.rejects(
      resolveContext7Library(
        { libraryName: 'react', query: 'hooks' },
        {
          readKey: async () => `${key}-${sentinel}`,
          fetch: async () => {
            responseCalls += 1;
            return jsonResponse({ error: sentinel }, status);
          },
        },
      ),
      error => pattern.test(error.message) && !error.message.includes(sentinel),
    );
  }
  assert.equal(responseCalls, 4);
  await assert.rejects(
    resolveContext7Library(
      { libraryName: 'react', query: 'hooks' },
      {
        readKey: async () => key,
        fetch: async () => {
          throw new Error(sentinel);
        },
      },
    ),
    error => /network|transport/i.test(error.message) && !error.message.includes(sentinel),
  );
  await assert.rejects(
    resolveContext7Library(
      { libraryName: 'react', query: 'hooks' },
      {
        readKey: async () => key,
        fetch: async () => jsonResponse({ unexpected: sentinel }),
      },
    ),
    error => /unexpected|invalid/i.test(error.message) && !error.message.includes(sentinel),
  );
});

test('categorizes syntactically invalid JSON responses as unexpected without leaking their body', async () => {
  const sentinel = 'invalid-private-response-body';
  await assert.rejects(
    resolveContext7Library(
      { libraryName: 'react', query: 'hooks' },
      {
        readKey: async () => key,
        fetch: async () =>
          new Response(`{${sentinel}`, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    ),
    error => /unexpected response/i.test(error.message) && !error.message.includes(sentinel),
  );
});

test('rejects malformed normalized SDK results from an injected client', async () => {
  await assert.rejects(
    getContext7Docs(
      { libraryId: '/a/b', query: 'x' },
      {
        readKey: async () => key,
        clientFactory: () => ({ getContext: async () => [{ title: 'x', content: 42, source: 'secret' }] }),
      },
    ),
    /unexpected/i,
  );
  await assert.rejects(
    resolveContext7Library(
      { libraryName: 'x', query: 'x' },
      {
        readKey: async () => key,
        clientFactory: () => ({ searchLibrary: async () => 'not-json' }),
      },
    ),
    /unexpected/i,
  );
});
