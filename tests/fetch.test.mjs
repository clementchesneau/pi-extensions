import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPage } from '../packages/web/fetch.js';
import { minimalPdf } from './fixtures/minimal-pdf.mjs';
import { TINY_IMAGES } from './fixtures/tiny-images.mjs';

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

const pdfResponse = (bytes, contentType = 'application/pdf') => ({
  url: 'https://example.com/report.pdf',
  status: 200,
  headers: { 'content-type': contentType },
  body: '',
  bytes,
});

test('extracts PDF text locally with page markers and the document title', async () => {
  const bytes = minimalPdf(['Quarterly results', 'Second page text'], { title: 'Annual Report' });
  const page = await fetchPage({ url: 'https://example.com/report.pdf' }, { request: async () => pdfResponse(bytes) });
  assert.equal(page.url, 'https://example.com/report.pdf');
  assert.equal(page.title, 'Annual Report');
  assert.equal(page.extraction, 'pdf');
  assert.match(page.markdown, /\[Page 1 of 2\]\nQuarterly results\n\n\[Page 2 of 2\]\nSecond page text/);
});

test('asks for PDFs and allows them 20 MiB while other pages keep the 4 MiB limit', async () => {
  let options;
  await fetchPage(
    { url: 'https://example.com/report.pdf' },
    {
      request: async (_url, requestOptions) => {
        options = requestOptions;
        return pdfResponse(minimalPdf(['Limits']));
      },
    },
  );
  assert.ok(options.headers.Accept.includes('application/pdf'));
  assert.equal(options.maxBytes({ 'content-type': 'application/pdf' }), 20 * 1024 * 1024);
  assert.equal(options.maxBytes({ 'content-type': 'application/octet-stream' }), 20 * 1024 * 1024);
  assert.equal(options.maxBytes({ 'content-type': 'text/html; charset=utf-8' }), 4 * 1024 * 1024);
  assert.equal(options.maxBytes({}), 4 * 1024 * 1024);
});

test('reads PDFs served as generic binary content by their signature only', async () => {
  const bytes = minimalPdf(['Served as octet stream']);
  const page = await fetchPage(
    { url: 'https://example.com/download' },
    { request: async () => pdfResponse(bytes, 'application/octet-stream') },
  );
  assert.match(page.markdown, /Served as octet stream/);
  assert.equal(page.title, 'https://example.com/report.pdf');
  await assert.rejects(
    fetchPage(
      { url: 'https://example.com/download' },
      { request: async () => pdfResponse(Buffer.from('MZ binary'), 'application/octet-stream') },
    ),
    /Unsupported page content type: application\/octet-stream/,
  );
});

test('reports a PDF without extractable text as possibly scanned, since OCR is not supported', async () => {
  await assert.rejects(
    fetchPage({ url: 'https://example.com/scan.pdf' }, { request: async () => pdfResponse(minimalPdf(['', ''])) }),
    /no extractable text.*scanned.*OCR is not supported/i,
  );
  await assert.rejects(
    fetchPage(
      { url: 'https://example.com/broken.pdf' },
      { request: async () => pdfResponse(Buffer.from('%PDF-1.4 x')) },
    ),
    /Cannot read this PDF/,
  );
});

const IMAGES = TINY_IMAGES;
const imageResponse = (contentType, bytes) => async (_url, requestOptions) => ({
  url: 'https://example.com/diagram',
  status: 200,
  headers: { 'content-type': contentType },
  body: '',
  bytes,
  requestOptions,
});

test('returns PNG, JPEG, GIF and WebP images for the model within the page size limit', async () => {
  for (const [mimeType, bytes] of Object.entries(IMAGES)) {
    let options;
    const respond = imageResponse(mimeType, bytes);
    const page = await fetchPage(
      { url: 'https://example.com/diagram' },
      { request: async (url, requestOptions) => ((options = requestOptions), respond(url, requestOptions)) },
    );
    assert.equal(page.url, 'https://example.com/diagram');
    assert.equal(page.extraction, 'image');
    assert.deepEqual(page.image, { data: bytes.toString('base64'), mimeType });
    assert.ok(options.headers.Accept.includes(mimeType));
    assert.equal(options.maxBytes({ 'content-type': mimeType }), 4 * 1024 * 1024);
  }
});

test('the image type sent to the model comes from the file signature, not the declared type', async () => {
  const png = await fetchPage(
    { url: 'https://example.com/a' },
    { request: imageResponse('image/jpeg', IMAGES['image/png']) },
  );
  assert.equal(png.image.mimeType, 'image/png');
  const jpg = await fetchPage(
    { url: 'https://example.com/b' },
    { request: imageResponse('image/jpg', IMAGES['image/jpeg']) },
  );
  assert.equal(jpg.image.mimeType, 'image/jpeg');
  for (const [contentType, bytes] of [
    ['image/png', Buffer.from('<!doctype html><title>Not found</title>')],
    ['image/webp', Buffer.alloc(0)],
  ]) {
    await assert.rejects(
      fetchPage({ url: 'https://example.com/c' }, { request: imageResponse(contentType, bytes) }),
      new RegExp(`declared as ${contentType.replace('/', '\\/')} but is not a PNG, JPEG, GIF or WebP image`),
    );
  }
  await assert.rejects(
    fetchPage(
      { url: 'https://example.com/logo.svg' },
      { request: imageResponse('image/svg+xml', Buffer.from('<svg/>')) },
    ),
    /Unsupported image type: image\/svg\+xml.*PNG, JPEG, GIF and WebP/,
  );
});

test('an image that cannot be decoded is refused rather than sent to the model', async () => {
  const truncated = IMAGES['image/png'].subarray(0, 10);
  await assert.rejects(
    fetchPage({ url: 'https://example.com/broken.png' }, { request: imageResponse('image/png', truncated) }),
    /image cannot be decoded: it may be truncated or corrupt/,
  );
});

test('accepts plain text and Markdown but rejects failed and empty pages', async () => {
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
    { status: 200, headers: { 'content-type': 'application/zip' }, body: '', bytes: Buffer.from('PK') },
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
