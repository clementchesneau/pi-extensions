import { readBraveApiKey } from './config.js';

const LANGUAGES = new Set(
  'ar eu bn bg ca zh-hans zh-hant hr cs da nl en en-gb et fi fr gl de gu he hi hu is it jp kn ko lv lt ms ml mr nb pl pt-br pt-pt pa ro ru sr sk sl es sv ta te th tr uk vi'.split(
    ' ',
  ),
);

export function publicResultUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function assertSearchParams({ query, count, freshness, language }) {
  if (typeof query !== 'string' || !query.trim() || query.length > 400 || query.trim().split(/\s+/).length > 50) {
    throw new Error('Query must contain 1–400 characters and at most 50 words.');
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('Count must be an integer from 1 to 20.');
  if (freshness !== undefined && !['pd', 'pw', 'pm', 'py'].includes(freshness))
    throw new Error('Freshness must be pd, pw, pm or py.');
  if (language !== undefined && !LANGUAGES.has(language)) throw new Error('Unsupported Brave search language code.');
}

async function braveApiKey(options) {
  const apiKey = options.apiKey ?? (await readBraveApiKey({ env: options.env, filePath: options.configPath }));
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]+$/.test(apiKey))
    throw new Error(
      'Set a valid BRAVE_API_KEY in your environment or ~/.config/pi-extensions/.env before using web_search. Verify your Brave spending limits first.',
    );
  return apiKey;
}

function searchUrl({ query, count, freshness, language }) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.search = new URLSearchParams({
    q: query.trim(),
    count: String(count),
    result_filter: 'web',
    text_decorations: 'false',
  }).toString();
  if (freshness) url.searchParams.set('freshness', freshness);
  if (language) url.searchParams.set('search_lang', language);
  return url;
}

async function requestBrave(url, apiKey, options) {
  const request = options.request ?? (await import('./http.js')).publicGet;
  try {
    return await request(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      signal: options.signal,
      maxRedirects: 0,
      maxBytes: 2 * 1024 * 1024,
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error?.name === 'TimeoutError') throw new Error('Brave request timed out. No automatic retry was made.');
    // Never surface raw transport errors: header-validation errors may contain secrets.
    throw new Error('Brave network request failed. No automatic retry was made.');
  }
}

function assertBraveStatus(status) {
  if (status === 401 || status === 403)
    throw new Error('Brave rejected the API key or subscription (HTTP ' + status + ').');
  if (status === 429) throw new Error('Brave quota or rate limit reached (HTTP 429). No automatic retry was made.');
  if (status !== 200) throw new Error(`Brave request failed (HTTP ${status}). No automatic retry was made.`);
}

function parseBraveResults(body, count) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('Brave returned invalid JSON.');
  }
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    data.error ||
    (data.web !== undefined && !Array.isArray(data.web?.results))
  ) {
    throw new Error('Brave returned an unexpected response.');
  }
  return (data.web?.results ?? [])
    .flatMap(item => {
      if (!item || typeof item.title !== 'string') return [];
      const url = publicResultUrl(item.url);
      if (!url) return [];
      return [
        {
          title: item.title,
          url,
          snippet: typeof item.description === 'string' ? item.description : '',
          ...(typeof item.age === 'string' ? { age: item.age } : {}),
        },
      ];
    })
    .slice(0, count);
}

export async function searchWeb(params, options = {}) {
  const { query, count = 5, freshness, language } = params;
  const search = { query, count, freshness, language };
  assertSearchParams(search);
  const apiKey = await braveApiKey(options);
  const response = await requestBrave(searchUrl(search), apiKey, options);
  assertBraveStatus(response.status);
  return { provider: 'Brave Search', query: query.trim(), results: parseBraveResults(response.body, count) };
}
