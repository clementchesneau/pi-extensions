import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPage } from '../packages/web/fetch.js';
import { pdfPage } from '../packages/web/pdf.js';
import { minimalPdf } from './fixtures/minimal-pdf.mjs';

// Thousands of pages take seconds to extract: long enough to observe cancellation and the time limit.
const largePdf = minimalPdf(Array.from({ length: 10_000 }, (_, index) => `Page ${index}`));

test('cancelling stops PDF extraction at once, without waiting for it to finish', async () => {
  const started = Date.now();
  await assert.rejects(
    fetchPage(
      { url: 'https://example.com/large.pdf' },
      {
        signal: AbortSignal.timeout(50),
        request: async () => ({
          url: 'https://example.com/large.pdf',
          status: 200,
          headers: { 'content-type': 'application/pdf' },
          body: '',
          bytes: largePdf,
        }),
      },
    ),
    error => error.name === 'TimeoutError' || error.name === 'AbortError',
  );
  assert.ok(Date.now() - started < 1_500, `extraction was not stopped (${Date.now() - started} ms)`);
});

test('PDF extraction has a time limit', async () => {
  await assert.rejects(
    pdfPage(largePdf, 'https://example.com/large.pdf', { timeoutMs: 100 }),
    /PDF text extraction took longer than 0\.1 seconds/,
  );
});

test('a PDF without text names both scanned images and undecodable fonts', async () => {
  await assert.rejects(
    pdfPage(minimalPdf(['']), 'https://example.com/scan.pdf'),
    /no extractable text.*scanned images \(OCR is not supported\).*fonts whose text cannot be decoded/,
  );
});

test('a PDF served as S3 binary content is read by its signature', async () => {
  const page = await fetchPage(
    { url: 'https://bucket.example/report' },
    {
      request: async () => ({
        url: 'https://bucket.example/report',
        status: 200,
        headers: { 'content-type': 'binary/octet-stream' },
        body: '',
        bytes: minimalPdf(['From a bucket']),
      }),
    },
  );
  assert.match(page.markdown, /From a bucket/);
});
