import assert from 'node:assert/strict';
import test from 'node:test';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import videoExtension from '../packages/video/index.js';
import { createFakePi } from './fixtures/fake-pi.mjs';
import { info, setup, URL_SOURCE } from './fixtures/video-setup.mjs';

const API = 'https://generativelanguage.googleapis.com';
const answer = text => ({ candidates: [{ content: { parts: [{ text }] } }] });

/** A Gemini API double answering by method and URL, recording every request. */
function gemini(routes) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body ? 'stream' : undefined;
    requests.push({ method: init.method ?? 'GET', url, headers: init.headers ?? {}, body });
    const route = routes[`${init.method ?? 'GET'} ${url}`];
    if (!route) return new Response(JSON.stringify({ error: { message: 'no route' } }), { status: 404 });
    return typeof route === 'function' ? route() : route;
  };
  return { requests, fetch };
}
const json = (value, init) => new Response(JSON.stringify(value), init);
const generate = model => `POST ${API}/v1beta/models/${model}:generateContent`;
const config = { GEMINI_API_KEY: 'test-key' };

test('video_ask is registered only when a Gemini key is configured', async t => {
  const saved = process.env.GEMINI_API_KEY;
  t.after(() => (saved === undefined ? delete process.env.GEMINI_API_KEY : (process.env.GEMINI_API_KEY = saved)));
  for (const [key, expected] of [
    ['', false],
    ['configured', true],
  ]) {
    process.env.GEMINI_API_KEY = key;
    const fake = createFakePi();
    await videoExtension(fake.pi);
    assert.equal(fake.tools.has('video_ask'), expected, `key "${key}"`);
    assert.ok(fake.tools.has('video_overview') && fake.tools.has('video_frames'));
  }
});

test('a YouTube URL goes to Gemini directly, with the question and an optional clip', async t => {
  const api = gemini({ [generate('gemini-3.5-flash-lite')]: () => json(answer('A cat plays the piano.')) });
  const { tools, calls } = await setup(t, { info: info({ duration: 3600 }) }, { config, gemini: { fetch: api.fetch } });
  const result = await tools.video_ask.execute('1', { source: URL_SOURCE, question: 'What happens?' });
  assert.match(result.content[0].text, /untrusted/i);
  assert.match(result.content[0].text, /Model: gemini-3\.5-flash-lite\n\nA cat plays the piano\./);
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].headers['x-goog-api-key'], 'test-key');
  assert.deepEqual(api.requests[0].body.contents[0].parts, [
    { fileData: { fileUri: URL_SOURCE } },
    { text: 'What happens?' },
  ]);
  assert.ok(!(await calls()).some(call => call.args.includes('--print')));

  await tools.video_ask.execute('2', { source: URL_SOURCE, question: 'And here?', from: '10:00', to: '12:00' });
  assert.deepEqual(api.requests[1].body.contents[0].parts[0], {
    fileData: { fileUri: URL_SOURCE },
    videoMetadata: { startOffset: '600s', endOffset: '720s' },
  });
});

test('another video is uploaded, processed, asked about and deleted, with the configured model', async t => {
  const file = { name: 'files/abc', uri: `${API}/v1beta/files/abc`, mimeType: 'video/mp4' };
  let polls = 0;
  const api = gemini({
    [`POST ${API}/upload/v1beta/files`]: () =>
      json({}, { headers: { 'x-goog-upload-url': `${API}/upload/session/1` } }),
    [`POST ${API}/upload/session/1`]: () => json({ file: { ...file, state: 'PROCESSING' } }),
    [`GET ${API}/v1beta/files/abc`]: () => json({ ...file, state: ++polls < 2 ? 'PROCESSING' : 'ACTIVE' }),
    [generate('gemini-pro-test')]: () => json(answer('Someone dances.')),
    [`DELETE ${API}/v1beta/files/abc`]: () => json({}),
  });
  const tiktok = info({ extractor_key: 'TikTok', webpage_url: 'https://www.tiktok.com/@a/video/1', duration: 20 });
  const { tools } = await setup(
    t,
    { info: tiktok },
    { config: { ...config, GEMINI_VIDEO_MODEL: 'gemini-pro-test' }, gemini: { fetch: api.fetch, pollMs: 1 } },
  );
  const result = await tools.video_ask.execute('1', {
    source: 'https://www.tiktok.com/@a/video/1',
    question: 'Describe',
  });
  assert.match(result.content[0].text, /Someone dances\./);
  assert.deepEqual(
    api.requests.map(request => `${request.method} ${request.url.replace(API, '')}`),
    [
      'POST /upload/v1beta/files',
      'POST /upload/session/1',
      'GET /v1beta/files/abc',
      'GET /v1beta/files/abc',
      'POST /v1beta/models/gemini-pro-test:generateContent',
      'DELETE /v1beta/files/abc',
    ],
  );
  // The downloaded video is rewritten as MP4 (16 bytes from the fake ffmpeg) before the upload.
  assert.equal(api.requests[0].headers['X-Goog-Upload-Header-Content-Length'], '16');
  assert.deepEqual(api.requests[4].body.contents[0].parts[0], {
    fileData: { fileUri: file.uri, mimeType: 'video/mp4' },
  });
  assert.equal(result.details.uploaded, true);
});

test('the uploaded file is deleted even when the question fails, and API errors never echo the key', async t => {
  const file = { name: 'files/x', uri: `${API}/v1beta/files/x`, mimeType: 'video/mp4', state: 'ACTIVE' };
  const api = gemini({
    [`POST ${API}/upload/v1beta/files`]: () =>
      json({}, { headers: { 'x-goog-upload-url': `${API}/upload/session/2` } }),
    [`POST ${API}/upload/session/2`]: () => json({ file }),
    [generate('gemini-3.5-flash-lite')]: () => json({ error: { message: 'Quota exceeded' } }, { status: 429 }),
    [`DELETE ${API}/v1beta/files/x`]: () => json({}),
  });
  const probe = { format: { duration: '20.0' }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] };
  const { tools, directory } = await setup(t, { probe }, { config, gemini: { fetch: api.fetch, pollMs: 1 } });
  await writeFile(join(directory, 'clip.mp4'), 'local video');
  await assert.rejects(
    tools.video_ask.execute('1', { source: 'clip.mp4', question: 'Q' }, undefined, undefined, { cwd: directory }),
    error =>
      /Gemini request failed \(HTTP 429\): Quota exceeded/.test(error.message) && !error.message.includes('test-key'),
  );
  assert.equal(api.requests.at(-1).method, 'DELETE');
});

test('a file over 200 MB needs a range, and a range sends only the cut part', async t => {
  const file = { name: 'files/c', uri: `${API}/v1beta/files/c`, mimeType: 'video/mp4', state: 'ACTIVE' };
  const api = gemini({
    [`POST ${API}/upload/v1beta/files`]: () =>
      json({}, { headers: { 'x-goog-upload-url': `${API}/upload/session/3` } }),
    [`POST ${API}/upload/session/3`]: () => json({ file }),
    [generate('gemini-3.5-flash-lite')]: () => json(answer('Part answer.')),
    [`DELETE ${API}/v1beta/files/c`]: () => json({}),
  });
  const probe = { format: { duration: '3000' }, streams: [{ codec_type: 'video' }] };
  const { tools, directory, calls } = await setup(
    t,
    { probe, outputBytes: 64 },
    { config, gemini: { fetch: api.fetch } },
  );
  const big = await open(join(directory, 'screen.mov'), 'w');
  await big.truncate(201 * 1024 * 1024);
  await big.close();
  await assert.rejects(
    tools.video_ask.execute('1', { source: 'screen.mov', question: 'Q' }, undefined, undefined, { cwd: directory }),
    /201 MB.*over the 200 MB limit.*from and to/,
  );
  assert.deepEqual(api.requests, []);
  const result = await tools.video_ask.execute(
    '2',
    { source: 'screen.mov', question: 'Q', from: '1:00', to: '2:00' },
    undefined,
    undefined,
    { cwd: directory },
  );
  assert.match(result.content[0].text, /Range: 1:00 to 2:00/);
  assert.equal(api.requests[0].headers['X-Goog-Upload-Header-Content-Length'], '64');
  const cut = (await calls()).find(call => call.program === 'ffmpeg' && call.args.includes('copy'));
  assert.deepEqual(cut.args.slice(cut.args.indexOf('-ss'), cut.args.indexOf('-ss') + 4), ['-ss', '60', '-t', '60']);
});

test('Esc while Gemini answers still deletes the uploaded video', async t => {
  const file = { name: 'files/esc', uri: `${API}/v1beta/files/esc`, mimeType: 'video/mp4', state: 'ACTIVE' };
  const controller = new AbortController();
  const api = gemini({
    [`POST ${API}/upload/v1beta/files`]: () =>
      json({}, { headers: { 'x-goog-upload-url': `${API}/upload/session/e` } }),
    [`POST ${API}/upload/session/e`]: () => json({ file }),
    [`DELETE ${API}/v1beta/files/esc`]: () => json({}),
  });
  const fetch = async (url, init = {}) => {
    if (url.includes(':generateContent')) {
      controller.abort();
      init.signal.throwIfAborted();
    }
    if (init.signal?.aborted) throw init.signal.reason;
    return api.fetch(url, init);
  };
  const probe = { format: { duration: '20', format_name: 'mov,mp4' }, streams: [{ codec_type: 'video' }] };
  const { tools, directory } = await setup(t, { probe }, { config, gemini: { fetch, pollMs: 1 } });
  await writeFile(join(directory, 'clip.mp4'), 'local video');
  await assert.rejects(
    tools.video_ask.execute('1', { source: 'clip.mp4', question: 'Q' }, controller.signal, undefined, {
      cwd: directory,
    }),
    { name: 'AbortError' },
  );
  assert.equal(api.requests.at(-1).method, 'DELETE');
});

test('local files are remuxed to MP4 before upload, and answers about a part say where its times start', async t => {
  const file = { name: 'files/r', uri: `${API}/v1beta/files/r`, mimeType: 'video/mp4', state: 'ACTIVE' };
  const api = gemini({
    [`POST ${API}/upload/v1beta/files`]: () =>
      json({}, { headers: { 'x-goog-upload-url': `${API}/upload/session/r` } }),
    [`POST ${API}/upload/session/r`]: () => json({ file }),
    [generate('gemini-3.5-flash-lite')]: () => json(answer('At 0:12 a door opens.')),
    [`DELETE ${API}/v1beta/files/r`]: () => json({}),
  });
  const probe = { format: { duration: '600', format_name: 'matroska,webm' }, streams: [{ codec_type: 'video' }] };
  const { tools, directory, calls } = await setup(
    t,
    { probe, outputBytes: 32 },
    { config, gemini: { fetch: api.fetch } },
  );
  await writeFile(join(directory, 'screen.mkv'), 'matroska bytes');
  const updates = [];
  const whole = await tools.video_ask.execute(
    '1',
    { source: 'screen.mkv', question: 'Q' },
    undefined,
    u => updates.push(u),
    {
      cwd: directory,
    },
  );
  const remux = (await calls()).find(call => call.program === 'ffmpeg' && call.args.includes('copy'));
  assert.ok(remux.args.at(-1).endsWith('.mp4'));
  assert.ok(!remux.args.includes('-ss'));
  assert.doesNotMatch(whole.content[0].text, /times start/);
  assert.ok(updates.some(update => /Uploading/.test(update.content[0].text)));
  const part = await tools.video_ask.execute(
    '2',
    { source: 'screen.mkv', question: 'Q', from: '5:00', to: '6:00' },
    undefined,
    undefined,
    {
      cwd: directory,
    },
  );
  assert.match(part.content[0].text, /Gemini saw only this part: 0:00 in its answer is 5:00 in the video\./);
});

test('a misconfigured key file still offers video_ask, whose call then explains the problem', async () => {
  const { createVideoExtension } = await import('../packages/video/index.js');
  const fake = createFakePi();
  await createVideoExtension({
    readConfig: async () => {
      throw new Error('Gemini configuration must have private permissions (chmod 0600).');
    },
  })(fake.pi);
  assert.ok(fake.tools.has('video_ask'));
});
