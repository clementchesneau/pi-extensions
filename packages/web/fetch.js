import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { fetchGitHub, githubTarget } from './github.js';
import { checkedUrl, publicGet } from './http.js';
import { IMAGE_TYPES, imagePage, imageType } from './image.js';
import { hasPdfSignature, pdfPage } from './pdf.js';
import { publicResultUrl } from './search.js';

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

/** Keeps only absolute public links, resolved against the page. */
function sanitizeLinks(document, baseUrl) {
  for (const node of document.querySelectorAll('a[href]')) {
    let href;
    try {
      href = publicResultUrl(new URL(node.getAttribute('href'), baseUrl));
    } catch {
      /* Drop invalid links. */
    }
    if (href) node.setAttribute('href', href);
    else node.removeAttribute('href');
  }
}

function htmlPage(body, finalUrl) {
  // linkedom parses inertly: no scripts, external resources or browser session.
  const { document } = parseHTML(body);
  const title = document.title?.trim() || finalUrl;
  for (const node of document.querySelectorAll(
    'script,style,noscript,iframe,object,embed,svg,form,nav,footer,header,aside,base',
  ))
    node.remove();
  sanitizeLinks(document, finalUrl);
  for (const image of document.querySelectorAll('img'))
    image.replaceWith(document.createTextNode(image.getAttribute('alt') ?? ''));
  const article = new Readability(document.cloneNode(true), { charThreshold: 0, maxElemsToParse: 50_000 }).parse();
  const html = article?.content || document.querySelector('main')?.innerHTML || document.body?.innerHTML || '';
  const extraction = article?.content ? 'article' : 'body-fallback';
  const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(html).trim();
  return { title, extraction, markdown };
}

const unsupported = type =>
  new Error(
    `Unsupported page content type: ${type || 'missing'}. Supports HTML, plain text, Markdown, JSON, PDF and images, not browser rendering.`,
  );

/**
 * Content served as generic binary, as servers often send PDFs and images: only its signature is
 * trusted. It is read up to the PDF limit, which only a PDF keeps.
 */
function binaryPage(response, type, signal) {
  const { bytes, url } = response;
  if (hasPdfSignature(bytes)) return pdfPage(bytes, url, { signal });
  if (!imageType(bytes)) throw unsupported(type);
  if (bytes.length > PAGE_LIMIT) throw new Error('Response exceeds the download size limit.');
  return imagePage(bytes, type, url);
}

async function readablePage(response, type, signal) {
  const finalUrl = response.url;
  const isJson = type === 'application/json' || /^application\/[\w.+-]+\+json$/.test(type);
  if (isJson || TEXT_TYPES.includes(type)) {
    // Preserve JSON verbatim: parsing could round large numeric identifiers.
    return { title: finalUrl, extraction: 'text', markdown: isJson ? response.body : response.body.trim() };
  }
  if (type === 'text/html') return htmlPage(response.body, finalUrl);
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
  // One deadline for every request behind the URL; PDF extraction keeps its own limit.
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
    maxBytes: headers => {
      const type = mediaType(headers);
      return PDF_TYPES.includes(type) || BINARY_TYPES.includes(type) ? DOCUMENT_LIMIT : PAGE_LIMIT;
    },
  });
  if (response.status !== 200) throw pageError(response.status, github);
  signal?.throwIfAborted();
  const { title, extraction, markdown, image } = await readablePage(response, mediaType(response.headers), signal);
  signal?.throwIfAborted();
  if (image) return { url: response.url, title, extraction, markdown, image };
  if (!markdown) throw new Error('No readable content found. The page may require JavaScript or authentication.');
  return { url: response.url, title, extraction, markdown };
}
