import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPage } from '../packages/web/fetch.js';

const json = value => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const base64 = text => Buffer.from(text).toString('base64');

/** A transport double answering by exact URL and recording what was requested. */
function routes(answers) {
  const requested = [];
  const request = async (url, options) => {
    requested.push({ url, accept: options.headers.Accept });
    const answer = answers[url];
    if (!answer) return { status: 404, headers: {}, body: '' };
    return { url, ...answer };
  };
  return { requested, request };
}

test('a repository URL gives its README and root listing through two public API calls', async () => {
  const { requested, request } = routes({
    'https://api.github.com/repos/acme/widgets/contents/': json([
      { name: 'src', path: 'src', type: 'dir', size: 0 },
      { name: 'package.json', path: 'package.json', type: 'file', size: 1536 },
      { name: 'vendor', path: 'vendor', type: 'submodule', size: 0 },
    ]),
    'https://api.github.com/repos/acme/widgets/readme': json({ content: base64('# Widgets\nBuild widgets.') }),
  });
  const page = await fetchPage({ url: 'https://github.com/acme/widgets.git' }, { request });
  assert.deepEqual(
    requested.map(entry => entry.url),
    ['https://api.github.com/repos/acme/widgets/contents/', 'https://api.github.com/repos/acme/widgets/readme'],
  );
  assert.ok(requested.every(entry => entry.accept === 'application/vnd.github+json'));
  assert.equal(page.url, 'https://github.com/acme/widgets');
  assert.equal(page.title, 'acme/widgets');
  assert.equal(page.extraction, 'github-repository');
  assert.match(page.markdown, /- src\/\n- package\.json \(1\.5 KB\)\n- vendor \(submodule\)/);
  assert.match(page.markdown, /https:\/\/github\.com\/acme\/widgets\/blob\/HEAD\/<path>/);
  assert.match(page.markdown, /## README\n\n# Widgets\nBuild widgets\./);
});

test('a repository without a README still lists its files', async () => {
  const { request } = routes({
    'https://api.github.com/repos/acme/bare/contents/': json([
      { name: 'main.c', path: 'main.c', type: 'file', size: 12 },
    ]),
  });
  const page = await fetchPage({ url: 'https://github.com/acme/bare' }, { request });
  assert.match(page.markdown, /- main\.c \(12 B\)/);
  assert.match(page.markdown, /No README found\./);
});

test('a tree URL lists that directory at that reference', async () => {
  const { requested, request } = routes({
    'https://api.github.com/repos/acme/widgets/contents/src/lib?ref=v2.0': json([
      { name: 'index.js', path: 'src/lib/index.js', type: 'file', size: 2048 },
    ]),
  });
  const page = await fetchPage({ url: 'https://github.com/acme/widgets/tree/v2.0/src/lib' }, { request });
  assert.equal(requested.length, 1);
  assert.equal(page.url, 'https://github.com/acme/widgets/tree/v2.0/src/lib');
  assert.equal(page.title, 'acme/widgets/src/lib @ v2.0');
  assert.equal(page.extraction, 'github-directory');
  assert.match(page.markdown, /- src\/lib\/index\.js \(2\.0 KB\)/);
  assert.match(page.markdown, /https:\/\/github\.com\/acme\/widgets\/blob\/v2\.0\/<path>/);
});

test('a blob URL reads the raw file instead of the GitHub page', async () => {
  const { requested, request } = routes({
    'https://raw.githubusercontent.com/acme/widgets/main/src/index.js': {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'export const answer = 42;\n',
    },
  });
  const page = await fetchPage({ url: 'https://github.com/acme/widgets/blob/main/src/index.js#L3' }, { request });
  assert.deepEqual(
    requested.map(entry => entry.url),
    ['https://raw.githubusercontent.com/acme/widgets/main/src/index.js'],
  );
  assert.equal(page.markdown, 'export const answer = 42;');
});

const issue = {
  number: 7,
  title: 'Crash on start',
  state: 'open',
  html_url: 'https://github.com/acme/widgets/issues/7',
  user: { login: 'ana' },
  created_at: '2026-09-01T10:00:00Z',
  labels: [{ name: 'bug' }],
  body: 'It crashes.',
  comments: 1,
};

test('an issue gives its description and comments as Markdown', async () => {
  const { requested, request } = routes({
    'https://api.github.com/repos/acme/widgets/issues/7': json(issue),
    'https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100': json([
      { user: { login: 'bo' }, created_at: '2026-09-02T08:30:00Z', body: 'Reproduced.' },
    ]),
  });
  const page = await fetchPage({ url: 'https://github.com/acme/widgets/issues/7#issuecomment-1' }, { request });
  assert.equal(requested.length, 2);
  assert.equal(page.url, 'https://github.com/acme/widgets/issues/7');
  assert.equal(page.title, 'Crash on start · acme/widgets#7');
  assert.equal(page.extraction, 'github-issue');
  assert.match(
    page.markdown,
    /^# Crash on start \(#7\)\nIssue · open · opened by @ana on 2026-09-01\nLabels: bug\n\nIt crashes\./,
  );
  assert.match(page.markdown, /## Comments \(1\)\n\n### @bo · 2026-09-02\n\nReproduced\./);
});

test('a pull request links its diff, skips the comments call when there are none and says what is left out', async () => {
  const pull = {
    ...issue,
    title: 'Fix crash',
    state: 'closed',
    html_url: 'https://github.com/acme/widgets/pull/8',
    number: 8,
    body: null,
    comments: 0,
    labels: [],
    pull_request: { merged_at: '2026-09-03T12:00:00Z' },
  };
  const { requested, request } = routes({ 'https://api.github.com/repos/acme/widgets/issues/8': json(pull) });
  const page = await fetchPage({ url: 'https://github.com/acme/widgets/pull/8/files' }, { request });
  assert.equal(requested.length, 1);
  assert.equal(page.extraction, 'github-pull-request');
  assert.match(page.markdown, /^# Fix crash \(#8\)\nPull request · merged · opened by @ana on 2026-09-01\n/);
  assert.match(page.markdown, /Diff: https:\/\/github\.com\/acme\/widgets\/pull\/8\.diff/);
  assert.match(page.markdown, /No description\./);
  assert.match(page.markdown, /Inline review comments are not included\./);
  assert.doesNotMatch(page.markdown, /## Comments/);
});

test('missing or private targets and the anonymous rate limit point to the GitHub CLI', async () => {
  const { request } = routes({});
  await assert.rejects(
    fetchPage({ url: 'https://github.com/acme/secret/issues/1' }, { request }),
    /HTTP 404.*does not exist or is private.*GitHub CLI \(gh\)/,
  );
  const limited = async () => ({
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.UTC(2026, 9, 8, 17, 5) / 1000) },
    body: '',
  });
  await assert.rejects(
    fetchPage({ url: 'https://github.com/acme/widgets' }, { request: limited }),
    /rate limit.*60 requests per hour.*17:05 UTC.*GitHub CLI \(gh\)/,
  );
});

test('other GitHub pages are read as ordinary web pages', async () => {
  for (const url of [
    'https://github.com/orgs/acme/repositories',
    'https://github.com/acme/widgets/releases',
    'https://github.com/acme/widgets/issues',
    'https://github.com/acme',
    'https://gist.github.com/acme/abc',
  ]) {
    const { requested, request } = routes({
      [url]: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'Ordinary page' },
    });
    const page = await fetchPage({ url }, { request });
    assert.deepEqual(
      requested.map(entry => entry.url),
      [url],
    );
    assert.equal(page.markdown, 'Ordinary page');
  }
});

test('a two-segment GitHub page that is not a repository falls back to the ordinary page', async () => {
  const url = 'https://github.com/advisories/GHSA-jfh8-c2jp-5v3q';
  const { requested, request } = routes({
    [url]: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'Security advisory' },
  });
  const page = await fetchPage({ url }, { request });
  assert.deepEqual(
    requested.map(entry => entry.url),
    ['https://api.github.com/repos/advisories/GHSA-jfh8-c2jp-5v3q/contents/', url],
  );
  assert.equal(page.markdown, 'Security advisory');
});

test('a private repository or a private file still points to the GitHub CLI', async () => {
  const { request } = routes({});
  for (const url of ['https://github.com/acme/secret', 'https://github.com/acme/secret/blob/main/src/key.js']) {
    await assert.rejects(fetchPage({ url }, { request }), /HTTP 404.*private.*GitHub CLI \(gh\)/);
  }
});

test('http and www GitHub URLs use the API, and encoded references are sent once encoded', async () => {
  for (const url of ['http://github.com/acme/widgets/issues/7', 'https://www.github.com/acme/widgets/issues/7']) {
    const { requested, request } = routes({
      'https://api.github.com/repos/acme/widgets/issues/7': json({ ...issue, comments: 0 }),
    });
    await fetchPage({ url }, { request });
    assert.equal(requested[0].url, 'https://api.github.com/repos/acme/widgets/issues/7');
  }
  const { requested, request } = routes({
    'https://api.github.com/repos/acme/widgets/contents/src?ref=feat%2Fx': json([
      { name: 'a.js', path: 'src/a.js', type: 'file', size: 1 },
    ]),
  });
  const page = await fetchPage({ url: 'https://github.com/acme/widgets/tree/feat%2Fx/src' }, { request });
  assert.deepEqual(
    requested.map(entry => entry.url),
    ['https://api.github.com/repos/acme/widgets/contents/src?ref=feat%2Fx'],
  );
  assert.match(page.markdown, /https:\/\/github\.com\/acme\/widgets\/blob\/feat%2Fx\/<path>/);
});

test('a tree URL that designates a file is reported as not a directory', async () => {
  const { request } = routes({
    'https://api.github.com/repos/acme/widgets/contents/README.md?ref=main': json({ type: 'file', name: 'README.md' }),
  });
  await assert.rejects(
    fetchPage({ url: 'https://github.com/acme/widgets/tree/main/README.md' }, { request }),
    /does not designate a directory/,
  );
});

test('secondary and incomplete rate-limit answers still give a rate-limit message with the GitHub CLI', async () => {
  const answers = [
    { status: 429, headers: { 'x-ratelimit-remaining': '0' }, body: '' },
    { status: 403, headers: { 'retry-after': '60' }, body: '' },
  ];
  for (const answer of answers) {
    await assert.rejects(
      fetchPage({ url: 'https://github.com/acme/widgets/issues/7' }, { request: async () => answer }),
      error => /rate limit/.test(error.message) && /GitHub CLI \(gh\)/.test(error.message),
    );
  }
  await assert.rejects(
    fetchPage({ url: 'https://github.com/acme/widgets/issues/7' }, { request: async () => answers[1] }),
    /retry after 60 seconds/,
  );
});

test('an issue with more comments than one page says how many are shown', async () => {
  const { request } = routes({
    'https://api.github.com/repos/acme/widgets/issues/7': json({ ...issue, comments: 150 }),
    'https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100': json(
      Array.from({ length: 100 }, (_, index) => ({
        user: { login: `u${index}` },
        created_at: '2026-09-02',
        body: 'x',
      })),
    ),
  });
  const page = await fetchPage({ url: 'https://github.com/acme/widgets/issues/7' }, { request });
  assert.match(page.markdown, /## Comments \(150\)/);
  assert.match(page.markdown, /\[Showing the first 100 of 150 comments\.\]$/);
});

test('GitHub URLs obey the same URL refusals as other pages before any rewrite', async () => {
  const { requested, request } = routes({});
  for (const [url, refusal] of [
    ['ftp://github.com/acme/widgets', /Only public HTTP\(S\) URLs/],
    ['https://user:secret@github.com/acme/widgets/issues/7', /credentials/],
    ['https://github.com:8443/acme/widgets/blob/main/a.js', /Nonstandard ports/],
  ]) {
    await assert.rejects(fetchPage({ url }, { request }), refusal);
  }
  assert.deepEqual(requested, []);
});

test('the requests behind one GitHub URL share its 4 MiB budget', async () => {
  const listing = json([{ name: 'a.js', path: 'a.js', type: 'file', size: 1 }]);
  const limits = [];
  const request = async (url, options) => {
    limits.push(options.maxBytes);
    if (url.endsWith('/contents/')) return { url, ...listing };
    return { status: 404, headers: {}, body: '' };
  };
  await fetchPage({ url: 'https://github.com/acme/widgets' }, { request });
  assert.deepEqual(limits, [4 * 1024 * 1024, 4 * 1024 * 1024 - Buffer.byteLength(listing.body)]);
});

test('the requests behind one GitHub URL share its time limit', async () => {
  const slow = (url, { signal }) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(url.endsWith('/7') ? { url, ...json(issue) } : { url, ...json([]) }), 60);
      signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
    });
  await assert.rejects(
    fetchPage({ url: 'https://github.com/acme/widgets/issues/7' }, { request: slow, timeLimitMs: 80 }),
    { name: 'TimeoutError' },
  );
});

test('the requests behind one GitHub URL share its 4 redirects, including the fallback to the page', async () => {
  const listing = json([{ name: 'a.js', path: 'a.js', type: 'file', size: 1 }]);
  const allowed = [];
  const request = async (url, options) => {
    allowed.push(options.maxRedirects);
    if (url.endsWith('/contents/')) return { url, ...listing, redirects: 3 };
    return { status: 404, headers: {}, body: '', redirects: 1 };
  };
  await fetchPage({ url: 'https://github.com/acme/widgets' }, { request });
  assert.deepEqual(allowed, [4, 1]);

  allowed.length = 0;
  const moved = async (url, options) => {
    allowed.push(options.maxRedirects);
    if (url.startsWith('https://api.github.com/')) return { status: 404, headers: {}, body: '', redirects: 3 };
    return { url, status: 200, headers: { 'content-type': 'text/plain' }, body: 'Ordinary page' };
  };
  await fetchPage({ url: 'https://github.com/advisories/GHSA-x' }, { request: moved });
  assert.deepEqual(allowed, [4, 1]);
});
