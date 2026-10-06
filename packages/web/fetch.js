import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { publicGet } from './http.js';
import { publicResultUrl } from './search.js';

const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/x-markdown'];

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

function readablePage(response, type) {
  const finalUrl = response.url;
  const isJson = type === 'application/json' || /^application\/[\w.+-]+\+json$/.test(type);
  if (isJson || TEXT_TYPES.includes(type)) {
    // Preserve JSON verbatim: parsing could round large numeric identifiers.
    return { title: finalUrl, extraction: 'text', markdown: isJson ? response.body : response.body.trim() };
  }
  if (type === 'text/html') return htmlPage(response.body, finalUrl);
  throw new Error(
    `Unsupported page content type: ${type || 'missing'}. Supports HTML, plain text, Markdown and JSON, not PDF or browser rendering.`,
  );
}

/**
 * @param {{ url: string }} params
 * @param {{ signal?: AbortSignal, request?: typeof publicGet }} [options]
 */
export async function fetchPage({ url }, { signal, request = publicGet } = {}) {
  const response = await request(url, {
    signal,
    headers: { Accept: 'text/html, text/plain, text/markdown, application/json' },
  });
  if (response.status !== 200) {
    const hint =
      response.status === 415
        ? ' Unsupported Media Type: the server may reject the request headers (such as Accept).'
        : '';
    throw new Error(`Page request failed (HTTP ${response.status}).${hint}`);
  }
  signal?.throwIfAborted();
  const { title, extraction, markdown } = readablePage(response, mediaType(response.headers));
  signal?.throwIfAborted();
  if (!markdown) throw new Error('No readable content found. The page may require JavaScript or authentication.');
  return { url: response.url, title, extraction, markdown };
}
