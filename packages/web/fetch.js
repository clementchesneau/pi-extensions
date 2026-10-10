import { runExtractionWorker } from './extraction-worker.js';
import { fetchGitHub, githubTarget } from './github.js';
import { checkedUrl, publicGet } from './http.js';
import { IMAGE_TYPES, imagePage, imageType } from './image.js';
import { hasPdfSignature, pdfPage } from './pdf.js';

const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/x-markdown'];
const PDF_TYPES = ['application/pdf', 'application/x-pdf'];
// S3 serves files without a declared type as binary/octet-stream.
const BINARY_TYPES = ['application/octet-stream', 'binary/octet-stream'];
const PAGE_LIMIT = 4 * 1024 * 1024;
const TIME_LIMIT_MS = 20_000;
const MAX_REDIRECTS = 4;
const DOCUMENT_LIMIT = 20 * 1024 * 1024;

const mediaType = headers =>
  String(headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();

const unsupported = type =>
  new Error(
    `Unsupported page content type: ${type || 'missing'}. Supports HTML, plain text, Markdown, JSON, PDF and images, not browser rendering.`,
  );

/** Content served as generic binary, as servers often send PDFs and images: only its signature is trusted. */
function binaryPage(response, type, signal) {
  const { bytes, url } = response;
  if (hasPdfSignature(bytes)) return pdfPage(bytes, url, { signal });
  if (!imageType(bytes)) throw unsupported(type);
  return imagePage(bytes, type, url);
}

/** 20 MiB for a PDF, by its type or, for generic binary content, by its signature; 4 MiB otherwise. */
function sizeLimit(headers, head) {
  const type = mediaType(headers);
  if (PDF_TYPES.includes(type)) return DOCUMENT_LIMIT;
  if (BINARY_TYPES.includes(type) && (!head || hasPdfSignature(head))) return DOCUMENT_LIMIT;
  return PAGE_LIMIT;
}

/** Converts HTML in a worker stopped on cancellation or at the deadline shared by the URL's requests. */
function htmlPage(body, url, { signal, deadlineAt, timeLimitMs }) {
  return runExtractionWorker(
    new URL('./html-worker.js', import.meta.url),
    { body, url },
    {
      signal,
      timeoutMs: Math.max(0, deadlineAt - Date.now()),
      limitError: () => new Error(`This URL took longer than ${timeLimitMs / 1000} seconds to download and read.`),
    },
  );
}

async function readablePage(response, type, { signal, deadlineAt, timeLimitMs }) {
  const finalUrl = response.url;
  const isJson = type === 'application/json' || /^application\/[\w.+-]+\+json$/.test(type);
  if (isJson || TEXT_TYPES.includes(type)) {
    // Preserve JSON verbatim: parsing could round large numeric identifiers.
    return { title: finalUrl, extraction: 'text', markdown: isJson ? response.body : response.body.trim() };
  }
  if (type === 'text/html') return htmlPage(response.body, finalUrl, { signal, deadlineAt, timeLimitMs });
  if (type.startsWith('image/')) return imagePage(response.bytes, type, finalUrl);
  if (PDF_TYPES.includes(type)) return pdfPage(response.bytes, finalUrl, { signal });
  if (BINARY_TYPES.includes(type)) return binaryPage(response, type, signal);
  throw unsupported(type);
}

function pageError(status, github) {
  let hint = '';
  if (status === 415) hint = ' Unsupported Media Type: the server may reject the request headers (such as Accept).';
  else if (status === 404 && github) {
    hint =
      ' This GitHub content does not exist or is private; for a private repository, use the GitHub CLI (gh) through the shell if it is available.';
  }
  return new Error(`Page request failed (HTTP ${status}).${hint}`);
}

/**
 * @param {{ url: string }} params
 * @param {{ signal?: AbortSignal, request?: typeof publicGet, timeLimitMs?: number }} [options]
 */
export async function fetchPage({ url }, { signal, request = publicGet, timeLimitMs = TIME_LIMIT_MS } = {}) {
  // Rewrites below must not bypass the rules of the URL actually requested.
  checkedUrl(url);
  // One deadline for every request behind the URL and the HTML extraction; PDF extraction keeps its own limit.
  const deadlineAt = Date.now() + timeLimitMs;
  const deadline = AbortSignal.any([AbortSignal.timeout(timeLimitMs), ...(signal ? [signal] : [])]);
  // Bytes and redirects shared the same way; a fallback to the ordinary page inherits what is left.
  const budget = { remaining: PAGE_LIMIT, redirects: MAX_REDIRECTS };
  const github = githubTarget(url);
  if (github && github.type !== 'file') {
    const page = await fetchGitHub(github, { signal: deadline, request, budget });
    if (page) return page;
  }
  const response = await request(github?.type === 'file' ? github.rawUrl : url, {
    signal: deadline,
    maxRedirects: budget.redirects,
    headers: {
      Accept: `text/html, text/plain, text/markdown, application/json, application/pdf, ${IMAGE_TYPES.join(', ')}`,
    },
    maxBytes: sizeLimit,
  });
  if (response.status !== 200) throw pageError(response.status, github);
  signal?.throwIfAborted();
  const { title, extraction, markdown, image } = await readablePage(response, mediaType(response.headers), {
    signal,
    deadlineAt,
    timeLimitMs,
  });
  signal?.throwIfAborted();
  if (image) return { url: response.url, title, extraction, markdown, image };
  if (!markdown) throw new Error('No readable content found. The page may require JavaScript or authentication.');
  return { url: response.url, title, extraction, markdown };
}
