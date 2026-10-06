import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPage } from '../packages/web/fetch.js';

test('extracts HTML locally, resolves links against final URL and drops active content', async () => {
  const page = await fetchPage(
    { url: 'https://example.com/start' },
    {
      request: async () => ({
        url: 'https://example.com/docs/intro',
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><html><head><title>Documentation</title><base href="https://evil.example/"></head><body>
    <nav>Unwanted navigation</nav><main><h1>Install</h1><p>Install the package to get started.</p>
    <p><a href="../api">API reference</a> and <a href="javascript:alert(1)">unsafe link</a>.</p>
    <pre><code>pnpm install</code></pre><script>SECRET_SCRIPT()</script><iframe src="http://localhost/"></iframe>
    </main></body></html>`,
      }),
    },
  );
  assert.equal(page.url, 'https://example.com/docs/intro');
  assert.equal(page.title, 'Documentation');
  assert.match(page.markdown, /Install the package/);
  assert.match(page.markdown, /\[API reference\]\(https:\/\/example.com\/api\)/);
  assert.match(page.markdown, /pnpm install/);
  assert.doesNotMatch(page.markdown, /SECRET_SCRIPT|javascript:|Unwanted navigation|evil.example|localhost/);
});

test('requests and preserves JSON responses, including vendor JSON types', async () => {
  const url = 'https://api.github.com/repos/example/repo/git/trees/main';
  const body = '{"id":9007199254740993,"tree":[{"path":"SETUP.md"}]}';
  for (const contentType of [
    'application/json; charset=utf-8',
    'application/vnd.github+json',
    'application/problem+json',
  ]) {
    const page = await fetchPage(
      { url },
      {
        request: async (requestedUrl, { headers }) => {
          assert.equal(requestedUrl, url);
          assert.ok(
            headers.Accept.split(',')
              .map(value => value.trim())
              .includes('application/json'),
          );
          return { url, status: 200, headers: { 'content-type': contentType }, body: ` ${body}\n` };
        },
      },
    );
    assert.equal(page.markdown, ` ${body}\n`);
    assert.equal(page.extraction, 'text');
    assert.equal(page.url, url);
  }
});

test('reports HTTP errors without guessing authentication or exposing upstream bodies', async () => {
  for (const status of [403, 415, 429, 500]) {
    await assert.rejects(
      fetchPage(
        { url: 'https://example.com' },
        {
          request: async () => ({
            status,
            body: 'secret upstream error',
          }),
        },
      ),
      error => {
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(error.message, /authentication|block automated access|secret upstream error/);
        if (status === 415) assert.match(error.message, /Unsupported Media Type.*request headers/i);
        return true;
      },
    );
  }
});

test('accepts plain text and Markdown but rejects PDFs, failed and empty pages', async () => {
  for (const contentType of ['text/plain', 'text/markdown']) {
    const page = await fetchPage(
      { url: 'https://example.com/readme' },
      {
        request: async () => ({
          url: 'https://example.com/readme',
          status: 200,
          headers: { 'content-type': contentType },
          body: '# Hello\nworld',
        }),
      },
    );
    assert.equal(page.markdown, '# Hello\nworld');
  }
  for (const response of [
    { status: 403, body: 'secret upstream error' },
    { status: 200, headers: { 'content-type': 'application/pdf' }, body: '%PDF' },
    {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<html><body><script>render()</script></body></html>',
    },
  ]) {
    await assert.rejects(
      fetchPage({ url: 'https://example.com' }, { request: async () => response }),
      /HTTP 403|Unsupported|No readable/,
    );
  }
});
