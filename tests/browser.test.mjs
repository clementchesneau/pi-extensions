import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Check } from 'typebox/value';
import { createFakePi } from './fixtures/fake-pi.mjs';

async function fixture(t) {
  const server = createServer((req, res) => {
    if (req.url === '/dropped') {
      req.socket.destroy();
      return;
    }
    if (req.url === '/failure') {
      res.writeHead(503).end('unavailable');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/large') {
      res.end(`<p>${'é😀 '.repeat(15000)}</p>`);
      return;
    }
    if (req.url === '/errors') {
      res.end(
        `<script>console.error('fixture error'); fetch('/failure'); fetch('/dropped').catch(() => {}); setTimeout(() => { throw new Error('fixture crash') }, 0)</script><h1>Errors</h1>`,
      );
      return;
    }
    res.end(`<!doctype html><title>UI fixture</title>
      <style>body { font: 20px sans-serif } @media(max-width:600px) { h1 { font-size:24px } }</style>
      <h1>Profile</h1><label>Name <input aria-label="Name"></label>
      <button onclick="document.querySelector('output').textContent='Saved '+document.querySelector('input').value">Save</button>
      <output aria-live="polite"></output>
      <label><input type="checkbox" aria-label="Subscribe">Subscribe</label>
      <select aria-label="Theme"><option>Light</option><option>Dark</option></select>
      <div style="margin-top:1600px" id="bottom">Bottom</div>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('registers four on-demand tools and only a cleanup hook, with valid bounded schemas', async () => {
  const { default: extension } = await import('../packages/ui-check/index.js');
  const fake = createFakePi();
  extension(fake.pi);
  const tools = [...fake.tools.values()];
  assert.deepEqual(
    tools.map(tool => tool.name),
    ['browser_open', 'browser_act', 'browser_inspect', 'browser_close'],
  );
  assert.deepEqual(
    [...fake.handlers].map(([event, handlers]) => [event, handlers.length]),
    [['session_shutdown', 1]],
  );
  for (const tool of tools) assert.ok(tool.promptGuidelines.every(text => text.includes(tool.name)));
  assert.ok(Check(tools[0].parameters, { url: 'http://localhost:3000', width: 390, height: 844 }));
  assert.ok(!Check(tools[0].parameters, { url: 'http://localhost:3000', width: 9000 }));
  assert.ok(!Check(tools[1].parameters, { action: 'eval', code: 'alert(1)' }));
  assert.ok(Check(tools[2].parameters, { screenshot: true, target: { role: 'button', name: 'Save' } }));
  assert.ok(!Check(tools[2].parameters, { screenshot: 'yes' }));
  await fake.fire('session_shutdown');
  await fake.fire('session_shutdown');
});

test('rejects non-web and credential URLs without opening a page', async t => {
  const { createBrowserTools } = await import('../packages/ui-check/index.js');
  const { tools, close } = createBrowserTools();
  t.after(close);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://user:secret@localhost:3000']) {
    await assert.rejects(tools[0].execute('test', { url }), /HTTP\(S\)/);
  }
  await assert.rejects(tools[2].execute('test', {}), /browser_open/);
});

test('cancellation interrupts a waiting action, discards the browser and allows reopening', async t => {
  const { createBrowserTools } = await import('../packages/ui-check/index.js');
  const url = await fixture(t);
  const { tools, close } = createBrowserTools();
  t.after(close);
  const call = (name, params, signal) => tools.find(tool => tool.name === name).execute('test', params, signal);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(call('browser_open', { url }, cancelled.signal), { name: 'AbortError' });
  await call('browser_open', { url });
  const controller = new AbortController();
  const started = Date.now();
  const waiting = call('browser_act', { action: 'wait', target: { selector: '#never' } }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 100);
  t.after(() => clearTimeout(timer));
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.ok(Date.now() - started < 3000, 'must interrupt, not wait for the 10-second locator timeout');
  await assert.rejects(call('browser_inspect', {}), /browser_open/);
  await call('browser_open', { url });
  assert.match((await call('browser_inspect', {})).content[0].text, /Profile/);
});

test('returns actual viewport and component images, with private local evidence', async t => {
  const { createBrowserTools } = await import('../packages/ui-check/index.js');
  const url = await fixture(t);
  const { tools, close } = createBrowserTools();
  t.after(close);
  const call = (name, params, ctx) =>
    tools.find(tool => tool.name === name).execute('test', params, undefined, undefined, ctx);
  await call('browser_open', { url, width: 390, height: 844 });
  const result = await call('browser_inspect', { screenshot: true });
  t.after(() => rm(dirname(result.details.screenshotPath), { recursive: true, force: true }));
  const image = result.content.find(item => item.type === 'image');
  assert.equal(image.mimeType, 'image/jpeg');
  const bytes = Buffer.from(image.data, 'base64');
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff');
  assert.deepEqual(await readFile(result.details.screenshotPath), bytes);
  assert.equal((await stat(result.details.screenshotPath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(result.details.screenshotPath))).mode & 0o777, 0o700);
  assert.deepEqual(result.details.viewport, { width: 390, height: 844 });
  const component = await call('browser_inspect', { screenshot: true, target: { role: 'button', name: 'Save' } });
  assert.notEqual(component.content.find(item => item.type === 'image').data, image.data);
  assert.match(component.content[0].text, /button.*Save/);
  assert.doesNotMatch(component.content[0].text, /textbox/);
  await assert.rejects(call('browser_inspect', { screenshot: true }, { model: { input: ['text'] } }), /image/i);
});

test('reports page diagnostics and bounds large snapshots without duplicating them in metadata', async t => {
  const { createBrowserTools } = await import('../packages/ui-check/index.js');
  const url = await fixture(t);
  const { tools, close } = createBrowserTools();
  t.after(close);
  const call = (name, params) => tools.find(tool => tool.name === name).execute('test', params);
  await call('browser_open', { url: `${url}/errors` });
  let observed;
  for (let i = 0; i < 30; i++) {
    observed = await call('browser_inspect', {});
    if (
      observed.content[0].text.includes('503') &&
      observed.content[0].text.includes('fixture crash') &&
      observed.content[0].text.includes('requestfailed')
    )
      break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(observed.content[0].text, /fixture error/);
  assert.match(observed.content[0].text, /fixture crash/);
  assert.match(observed.content[0].text, /503/);
  assert.match(observed.content[0].text, /requestfailed/);
  const large = await call('browser_open', { url: `${url}/large` });
  t.after(() => rm(dirname(large.details.fullOutputPath), { recursive: true, force: true }));
  assert.equal(large.details.truncated, true);
  assert.ok(Buffer.byteLength(large.content[0].text) < 26_000);
  assert.ok(!large.content[0].text.includes('\uFFFD'));
  assert.ok(!('snapshot' in large.details));
  assert.ok((await readFile(large.details.fullOutputPath, 'utf8')).includes('é😀 '.repeat(15000).trim()));
  assert.equal((await stat(large.details.fullOutputPath)).mode & 0o777, 0o600);
});

test('interacts by accessible name, preserves state and changes viewport', async t => {
  const { createBrowserTools } = await import('../packages/ui-check/index.js');
  const url = await fixture(t);
  const { tools, close } = createBrowserTools();
  t.after(close);
  const call = (name, params) => tools.find(tool => tool.name === name).execute('test', params);
  await call('browser_open', { url });
  const act = params => call('browser_act', params);
  // Intentionally overlap calls, as Pi can do: fill must complete before Save.
  await Promise.all([
    act({ action: 'fill', target: { role: 'textbox', name: 'Name' }, value: 'Clément' }),
    act({ action: 'click', target: { role: 'button', name: 'Save' } }),
  ]);
  await act({ action: 'check', target: { role: 'checkbox', name: 'Subscribe' }, checked: true });
  await act({ action: 'select', target: { selector: 'select' }, value: 'Dark' });
  await act({ action: 'hover', target: { role: 'button', name: 'Save' } });
  await act({ action: 'press', target: { role: 'textbox', name: 'Name' }, key: 'Tab' });
  await act({ action: 'scroll', target: { selector: '#bottom' } });
  await act({ action: 'resize', width: 390, height: 844 });
  await act({ action: 'wait', target: { selector: 'output' }, state: 'visible' });
  const result = await call('browser_inspect', {});
  assert.deepEqual(result.details.viewport, { width: 390, height: 844 });
  assert.match(result.content[0].text, /Saved Clément/);
  assert.match(result.content[0].text, /Subscribe.*checked/);
  assert.match(result.content[0].text, /Dark.*selected/);
  await assert.rejects(act({ action: 'fill', target: { role: 'textbox', name: 'Name' } }), /value/);
  await assert.rejects(act({ action: 'click', target: { selector: 'input' } }), /strict mode violation/);
  await assert.rejects(act({ action: 'resize', width: 9000, height: 800 }), /viewport/i);
});

test('opens a real local UI, inspects accessible elements and closes lazily', async t => {
  const { createBrowserTools } = await import('../packages/ui-check/index.js');
  const url = await fixture(t);
  const { tools, close } = createBrowserTools();
  t.after(close);
  const call = (name, params) => tools.find(tool => tool.name === name).execute('test', params);
  await assert.rejects(call('browser_inspect', {}), /browser_open/);
  const opened = await call('browser_open', { url });
  assert.equal(opened.details.url, `${url}/`);
  assert.match(opened.content[0].text, /Profile/);
  assert.match(opened.content[0].text, /textbox.*Name/);
  assert.match(opened.content[0].text, /untrusted/i);
  await call('browser_close', {});
  await assert.rejects(call('browser_inspect', {}), /browser_open/);
  await close();
});

test('the README installs Chromium with the Playwright version the package depends on', async () => {
  const manifest = JSON.parse(await readFile(new URL('../packages/ui-check/package.json', import.meta.url), 'utf8'));
  const readme = await readFile(new URL('../packages/ui-check/README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes(`npx playwright@${manifest.dependencies.playwright} install chromium`));
});
