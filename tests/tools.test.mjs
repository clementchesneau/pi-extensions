import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import webExtension, { createWebTools } from '../packages/web/index.js';
import { Check } from 'typebox/value';
import { createFakePi } from './fixtures/fake-pi.mjs';

test('registers exactly four tools without a provider or a startup API call', () => {
  const fake = createFakePi();
  webExtension(fake.pi);
  const tools = [...fake.tools.values()];
  assert.deepEqual(
    tools.map(tool => tool.name),
    ['web_search', 'web_fetch', 'context7_resolve', 'context7_docs'],
  );
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object');
    assert.ok(tool.description);
    assert.ok(tool.promptGuidelines.every(text => text.includes(tool.name)));
  }
  assert.equal(Check(tools[0].parameters, { query: 'Pi', freshness: 'pw' }), true);
  assert.equal(Check(tools[0].parameters, { query: 'Pi', count: 1.5 }), false);
  assert.equal(Check(tools[0].parameters, { query: 'Pi', freshness: 'invalid' }), false);
  assert.equal(Check(tools[1].parameters, { url: 'https://example.com', extra: true }), false);
  assert.equal(Check(tools[2].parameters, { libraryName: 'react', query: 'hooks' }), true);
  assert.equal(Check(tools[2].parameters, { libraryName: 'react', query: 'hooks', extra: true }), false);
  assert.equal(Check(tools[3].parameters, { libraryId: '/facebook/react', query: 'hooks' }), true);
  assert.equal(Check(tools[3].parameters, { libraryId: '/facebook/react' }), false);
  const context7Guidelines = tools
    .slice(2)
    .flatMap(tool => tool.promptGuidelines)
    .join(' ');
  assert.match(context7Guidelines, /API|configuration|migration/i);
  assert.match(context7Guidelines, /secret/i);
  assert.match(context7Guidelines, /proprietary|personal/i);
  assert.match(context7Guidelines, /version/i);
  assert.match(context7Guidelines, /web_fetch/);
});

test('passes cancellation and arguments and distinguishes snippets from source pages', async () => {
  const signal = new AbortController().signal;
  const [search, fetch] = createWebTools({
    search: async (params, options) => {
      assert.deepEqual(params, { query: 'test' });
      assert.equal(options.signal, signal);
      return { provider: 'Brave Search', query: 'test', results: [] };
    },
    fetch: async (params, options) => {
      assert.equal(params.url, 'https://example.com');
      assert.equal(options.signal, signal);
      return { title: 'Example', url: 'https://example.com/', extraction: 'article', markdown: 'Readable text' };
    },
  });
  const searchResult = await search.execute('1', { query: 'test' }, signal);
  assert.match(searchResult.content[0].text, /untrusted/i);
  assert.match(searchResult.content[0].text, /not.*read|not.*page/i);
  const page = await fetch.execute('2', { url: 'https://example.com' }, signal);
  assert.match(page.content[0].text, /https:\/\/example.com/);
  assert.match(page.content[0].text, /Readable text/);
  assert.equal(page.details.extraction, 'article');
});

test('routes explicit Context7 resolve and docs calls with attributed untrusted output', async () => {
  const signal = new AbortController().signal;
  const updates = [];
  const tools = createWebTools({
    resolveContext7: async (params, options) => {
      assert.deepEqual(params, { libraryName: 'react', query: 'hooks' });
      assert.equal(options.signal, signal);
      return {
        provider: 'Context7',
        candidates: [
          {
            id: '/facebook/react/v19',
            name: 'React',
            description: 'UI',
            totalSnippets: 10,
            trustScore: 9,
            benchmarkScore: 95,
            versions: ['v19'],
          },
        ],
      };
    },
    getContext7: async (params, options) => {
      assert.deepEqual(params, { libraryId: '/facebook/react/v19', query: 'hooks' });
      assert.equal(options.signal, signal);
      return {
        provider: 'Context7',
        libraryId: params.libraryId,
        snippets: [
          {
            title: 'Hooks',
            content: 'Use hooks here.',
            source: 'https://react.dev/hooks',
          },
        ],
      };
    },
  });
  const resolved = await tools[2].execute('3', { libraryName: 'react', query: 'hooks' }, signal, update =>
    updates.push(update),
  );
  assert.match(resolved.content[0].text, /untrusted/i);
  assert.match(resolved.content[0].text, /\/facebook\/react\/v19/);
  assert.match(resolved.content[0].text, /95/);
  assert.equal(resolved.details.candidateCount, 1);
  assert.ok(!('candidates' in resolved.details));

  const docs = await tools[3].execute('4', { libraryId: '/facebook/react/v19', query: 'hooks' }, signal, update =>
    updates.push(update),
  );
  assert.match(docs.content[0].text, /https:\/\/react.dev\/hooks/);
  assert.match(docs.content[0].text, /Use hooks here/);
  assert.equal(docs.details.libraryId, '/facebook/react/v19');
  assert.equal(docs.details.snippetCount, 1);
  assert.equal(updates.length, 2);
});

test('caps Context7 output and saves its full attributed content privately', async t => {
  const content = 'documented behavior\n'.repeat(4000);
  const tools = createWebTools({
    getContext7: async params => ({
      provider: 'Context7',
      libraryId: params.libraryId,
      snippets: [{ title: 'Large', content, source: 'https://docs.example/api' }],
    }),
  });
  const result = await tools[3].execute('4', { libraryId: '/example/api', query: 'behavior' });
  t.after(() => rm(dirname(result.details.fullOutputPath), { recursive: true, force: true }));
  assert.equal(result.details.truncated, true);
  assert.match(await readFile(result.details.fullOutputPath, 'utf8'), /https:\/\/docs.example\/api/);
  assert.ok((await readFile(result.details.fullOutputPath, 'utf8')).includes(content));
  assert.ok(!('snippets' in result.details));
});

test('caps output and saves complete content privately for follow-up reads', async t => {
  const markdown = 'é😀 useful source content\n'.repeat(4000);
  const [, fetch] = createWebTools({
    fetch: async () => ({ title: 'Large', url: 'https://example.com/', extraction: 'text', markdown }),
  });
  const result = await fetch.execute('1', { url: 'https://example.com/' });
  const file = result.details.fullOutputPath;
  t.after(() => rm(dirname(file), { recursive: true, force: true }));
  assert.equal(result.details.truncated, true);
  assert.ok(Buffer.byteLength(result.content[0].text) < 26_000);
  assert.ok(result.content[0].text.split('\n').length < 620);
  assert.ok(result.content[0].text.includes(file));
  assert.ok(!('markdown' in result.details));
  assert.match(await readFile(file, 'utf8'), /é😀 useful source content/);
  assert.ok((await readFile(file, 'utf8')).includes(markdown));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('caps a single long Unicode line without splitting characters', async t => {
  const markdown = '😀'.repeat(20_000);
  const [, fetch] = createWebTools({
    fetch: async () => ({ title: 'Large', url: 'https://example.com/', extraction: 'text', markdown }),
  });
  const result = await fetch.execute('1', { url: 'https://example.com' });
  t.after(() => rm(dirname(result.details.fullOutputPath), { recursive: true, force: true }));
  assert.ok(Buffer.byteLength(result.content[0].text) < 26_000);
  assert.ok(!result.content[0].text.includes('\uFFFD'));
  assert.ok((await readFile(result.details.fullOutputPath, 'utf8')).includes(markdown));
});

test('web_fetch passes images to models that accept them and refuses text-only models', async () => {
  const url = 'https://example.com/diagram.png';
  const image = { data: 'iVBORw==', mimeType: 'image/png' };
  const [, fetch] = createWebTools({
    fetch: async () => ({ url, title: url, extraction: 'image', markdown: '', image }),
  });
  for (const ctx of [{ model: { input: ['text', 'image'] } }, {}]) {
    const result = await fetch.execute('1', { url }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /untrusted/i);
    assert.match(result.content[0].text, /Source: https:\/\/example.com\/diagram.png/);
    assert.deepEqual(result.content[1], { type: 'image', ...image });
    assert.deepEqual(result.details, { url, extraction: 'image', mimeType: 'image/png', truncated: false });
  }
  await assert.rejects(
    fetch.execute('2', { url }, undefined, undefined, { model: { input: ['text'] } }),
    /current model does not accept images/,
  );
});

test('does not start a cancelled tool and surfaces service failures as tool errors', async () => {
  const tools = createWebTools({
    search: () => assert.fail('must not run'),
    fetch: () => assert.fail('must not run'),
    resolveContext7: () => assert.fail('must not run'),
    getContext7: () => assert.fail('must not run'),
  });
  const controller = new AbortController();
  controller.abort();
  for (const tool of tools) await assert.rejects(tool.execute('1', {}, controller.signal), { name: 'AbortError' });
  const [search] = createWebTools({
    search: async () => {
      throw new Error('HTTP 429');
    },
  });
  await assert.rejects(search.execute('1', { query: 'x' }), /HTTP 429/);
});
