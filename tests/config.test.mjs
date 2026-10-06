import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBraveApiKey, readContext7ApiKey } from '../packages/web/config.js';
import { searchWeb } from '../packages/web/search.js';

async function fixture(t, text) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-config-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, '.env');
  if (text !== undefined) await writeFile(filePath, text, { mode: 0o600 });
  return { filePath, env: {} };
}

test('reads a private dotenv file without evaluating or exporting its contents', async t => {
  const options = await fixture(t, '# Local secret\nexport BRAVE_API_KEY="file-secret" # comment\nUNRELATED=value\n');
  assert.equal(await readBraveApiKey(options), 'file-secret');
  assert.deepEqual(options.env, {});
  await writeFile(options.filePath, "BRAVE_API_KEY='$(do-not-execute)'\n");
  assert.equal(await readBraveApiKey(options), '$(do-not-execute)');
});

test('explicit environment values win, including empty values, without reading the file', async t => {
  const options = await fixture(t, 'BRAVE_API_KEY=file-secret');
  await chmod(options.filePath, 0o644);
  assert.equal(await readBraveApiKey({ ...options, env: { BRAVE_API_KEY: 'env-secret' } }), 'env-secret');
  assert.equal(await readBraveApiKey({ ...options, env: { BRAVE_API_KEY: '' } }), '');
});

test('missing files or keys are allowed, and file updates take effect immediately', async t => {
  const options = await fixture(t);
  assert.equal(await readBraveApiKey(options), undefined);
  await writeFile(options.filePath, '# configure later\n', { mode: 0o600 });
  assert.equal(await readBraveApiKey(options), undefined);
  await writeFile(options.filePath, 'BRAVE_API_KEY=first-secret\n');
  assert.equal(await readBraveApiKey(options), 'first-secret');
  await writeFile(options.filePath, 'BRAVE_API_KEY=second-secret\n');
  assert.equal(await readBraveApiKey(options), 'second-secret');
});

test('rejects public permissions, symlinks and oversized files without revealing contents', async t => {
  const options = await fixture(t, 'BRAVE_API_KEY=private-secret');
  await chmod(options.filePath, 0o644);
  await assert.rejects(
    readBraveApiKey(options),
    error => /0600/.test(error.message) && !error.message.includes('private-secret'),
  );
  await chmod(options.filePath, 0o600);
  const link = join(options.filePath + '-link');
  await symlink(options.filePath, link);
  await assert.rejects(readBraveApiKey({ ...options, filePath: link }), /configuration/i);
  await writeFile(options.filePath, 'x'.repeat(20_000));
  await assert.rejects(readBraveApiKey(options), /size|large/i);
});

test('Context7 uses the same secure, reloadable configuration with service-specific errors', async t => {
  const options = await fixture(t, 'CONTEXT7_API_KEY=file-context7\n');
  assert.equal(await readContext7ApiKey(options), 'file-context7');
  assert.equal(await readContext7ApiKey({ ...options, env: { CONTEXT7_API_KEY: 'env-context7' } }), 'env-context7');
  assert.equal(await readContext7ApiKey({ ...options, env: { CONTEXT7_API_KEY: '' } }), '');

  await writeFile(options.filePath, 'CONTEXT7_API_KEY=updated-context7\n');
  assert.equal(await readContext7ApiKey(options), 'updated-context7');
  await chmod(options.filePath, 0o644);
  await assert.rejects(
    readContext7ApiKey(options),
    error =>
      /Context7/.test(error.message) && /0600/.test(error.message) && !error.message.includes('updated-context7'),
  );
});

test('Context7 configuration rejects symlinks and oversized files and allows missing values', async t => {
  const options = await fixture(t);
  assert.equal(await readContext7ApiKey(options), undefined);
  await writeFile(options.filePath, '# no Context7 key\n', { mode: 0o600 });
  assert.equal(await readContext7ApiKey(options), undefined);

  const link = `${options.filePath}-link`;
  await symlink(options.filePath, link);
  await assert.rejects(readContext7ApiKey({ ...options, filePath: link }), /Context7 configuration/i);
  await writeFile(options.filePath, 'x'.repeat(20_000));
  await assert.rejects(
    readContext7ApiKey(options),
    error => /Context7/.test(error.message) && /size|large/i.test(error.message),
  );
});

test('search uses the configured file key and never returns it in results', async t => {
  const options = await fixture(t, 'BRAVE_API_KEY=file-secret\n');
  const result = await searchWeb(
    { query: 'documentation' },
    {
      env: options.env,
      configPath: options.filePath,
      request: async (_url, options) => {
        assert.equal(options.headers['X-Subscription-Token'], 'file-secret');
        return { status: 200, body: '{}' };
      },
    },
  );
  assert.deepEqual(result.results, []);
  assert.ok(!JSON.stringify(result).includes('file-secret'));
});
