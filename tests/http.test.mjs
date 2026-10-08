import assert from 'node:assert/strict';
import test from 'node:test';
import { publicGet, requestPinned } from '../packages/web/http.js';
import { createServer } from 'node:http';

const answer = (body = 'ok', status = 200, headers = {}) => ({ body, status, headers });

test('blocks local, reserved and mapped addresses before any connection', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.168.1.1',
    '0.0.0.0',
    '192.0.2.1',
    '224.0.0.1',
    '::1',
    '::2',
    '4000::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2002:7f00:1::',
  ]) {
    let connected = false;
    await assert.rejects(
      publicGet(
        'https://example.com',
        {},
        {
          lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
          send: async () => {
            connected = true;
            return answer();
          },
        },
      ),
      /public|blocked/i,
    );
    assert.equal(connected, false, address);
  }
});

test('pins the checked DNS answer and rechecks redirect destinations', async () => {
  const destinations = [];
  await assert.rejects(
    publicGet(
      'https://example.com',
      {},
      {
        lookup: async host => [{ address: host === 'example.com' ? '93.184.215.14' : '127.0.0.1', family: 4 }],
        send: async (url, options) => {
          destinations.push(url.href);
          assert.equal(options.address.address, '93.184.215.14');
          return answer('', 302, { location: 'https://internal.example/' });
        },
      },
    ),
    /public|blocked/i,
  );
  assert.deepEqual(destinations, ['https://example.com/']);
});

test('rejects unsupported URLs, credentials, nonstandard ports and mixed DNS answers', async () => {
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com',
    'https://user:pass@example.com',
    'https://example.com:8080',
    'http://2130706433',
  ]) {
    await assert.rejects(publicGet(url), /public|blocked|HTTP|credentials|port/i);
  }
  await assert.rejects(
    publicGet(
      'https://example.com',
      {},
      {
        lookup: async () => [
          { address: '93.184.215.14', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
        send: async () => assert.fail('must not connect'),
      },
    ),
    /public|blocked/i,
  );
});

test('bounds redirects and aborts even during DNS resolution', async () => {
  let calls = 0;
  await assert.rejects(
    publicGet(
      'https://example.com',
      { maxRedirects: 0 },
      {
        lookup: async () => [{ address: '93.184.215.14', family: 4 }],
        send: async () => {
          calls++;
          return answer('', 302, { location: '/next' });
        },
      },
    ),
    /redirect/i,
  );
  assert.equal(calls, 1);
  const controller = new AbortController();
  const pending = publicGet(
    'https://example.com',
    { signal: controller.signal },
    {
      lookup: () => new Promise(() => {}),
      send: () => assert.fail('must not connect'),
    },
  );
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('real HTTP transport enforces byte limits, rejects compression and supports cancellation', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/slow') return;
    if (req.url === '/compressed') {
      res.setHeader('Content-Encoding', 'gzip');
      res.end('compressed');
      return;
    }
    res.end('a'.repeat(100));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  // This hostname cannot resolve normally: success proves the pinned lookup is used.
  const base = `http://pinning-test.invalid:${server.address().port}`;
  const options = { address: { address: '127.0.0.1', family: 4 }, maxBytes: 50 };
  await assert.rejects(requestPinned(new URL(base), options), /size|large|limit/i);
  await assert.rejects(requestPinned(new URL(base + '/compressed'), options), /encoding|compress/i);
  await assert.rejects(
    requestPinned(new URL(base + '/slow'), { ...options, signal: AbortSignal.timeout(30) }),
    /abort/i,
  );
  const result = await requestPinned(new URL(base), { ...options, maxBytes: 100 });
  assert.equal(result.body.length, 100);
});

test('real HTTP transport keeps binary bodies as bytes and sizes its limit by content type', async t => {
  const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x00, 0xfe]);
  const server = createServer((req, res) => {
    if (req.url === '/doc.pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.end(pdf);
    } else if (req.url === '/large.pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.end(Buffer.alloc(80));
    } else if (req.url === '/unknown-charset') {
      res.setHeader('Content-Type', 'text/html; charset=x-unknown');
      res.end('text');
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('é'.repeat(40));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://pinning-test.invalid:${server.address().port}`;
  const address = { address: '127.0.0.1', family: 4 };
  const maxBytes = headers => (headers['content-type'] === 'application/pdf' ? 100 : 50);

  const document = await requestPinned(new URL(`${base}/doc.pdf`), { address, maxBytes });
  assert.deepEqual(document.bytes, pdf);
  assert.equal(document.body, '');
  assert.equal((await requestPinned(new URL(`${base}/large.pdf`), { address, maxBytes })).bytes.length, 80);
  await assert.rejects(requestPinned(new URL(`${base}/page`), { address, maxBytes }), /size limit/);
  const page = await requestPinned(new URL(`${base}/page`), { address, maxBytes: 100 });
  assert.equal(page.body, 'é'.repeat(40));
  assert.equal(page.bytes.length, 80);
  await assert.rejects(
    requestPinned(new URL(`${base}/unknown-charset`), { address, maxBytes: 100 }),
    /Unsupported page character encoding/,
  );
});

test('reports how many redirects it followed, so callers can share one redirect limit', async () => {
  let calls = 0;
  const result = await publicGet(
    'https://example.com/a',
    { maxRedirects: 2 },
    {
      lookup: async () => [{ address: '93.184.215.14', family: 4 }],
      send: async () => (++calls <= 2 ? answer('', 301, { location: `/hop${calls}` }) : answer('final')),
    },
  );
  assert.equal(result.redirects, 2);
  assert.equal(result.url, 'https://example.com/hop2');
});

test('follows relative public redirects and rejects HTTPS downgrades', async () => {
  let calls = 0;
  const result = await publicGet(
    'https://example.com/start',
    {},
    {
      lookup: async () => [{ address: '93.184.215.14', family: 4 }],
      send: async url => (++calls === 1 ? answer('', 302, { location: '/final' }) : answer(url.pathname)),
    },
  );
  assert.equal(result.url, 'https://example.com/final');
  assert.equal(result.body, '/final');
  await assert.rejects(
    publicGet(
      'https://example.com',
      {},
      {
        lookup: async () => [{ address: '93.184.215.14', family: 4 }],
        send: async () => answer('', 302, { location: 'http://example.com' }),
      },
    ),
    /downgrade/,
  );
});
