// HTML to Markdown, run in a worker thread by html-worker.js.
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { publicResultUrl } from './search.js';

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

export function htmlPage(body, finalUrl) {
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
