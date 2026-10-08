import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MAX_BYTES, MAX_LINES, boundedText, writePrivateTempFile } from '../packages/shared/bounded-text.js';

function recordingSave() {
  const saved = [];
  return { saved, save: async text => (saved.push(text), '/private/full.txt') };
}

test('text within both limits is returned as is without saving', async () => {
  const { saved, save } = recordingSave();
  const text = Array.from({ length: MAX_LINES }, (_, index) => `line ${index}`).join('\n');
  assert.deepEqual(await boundedText(text, { save, subject: 'the complete source' }), { text, truncated: false });
  assert.deepEqual(saved, []);
});

test('more lines than the limit keeps the first lines and names the saved complete text', async () => {
  const { saved, save } = recordingSave();
  const text = Array.from({ length: MAX_LINES + 1 }, (_, index) => `line ${index}`).join('\n');
  const output = await boundedText(text, { save, subject: 'the complete source' });
  assert.equal(output.truncated, true);
  assert.equal(output.fullOutputPath, '/private/full.txt');
  assert.deepEqual(saved, [text]);
  assert.ok(output.text.startsWith('line 0\n'));
  assert.ok(!output.text.includes(`line ${MAX_LINES}\n`));
  assert.ok(output.text.endsWith('\n\n[Output truncated. Read the complete source from /private/full.txt]'));
});

test('the byte limit never splits a multi-byte character', async () => {
  const { save } = recordingSave();
  const output = await boundedText(`a${'é'.repeat(MAX_BYTES)}`, { save, subject: 'observations' });
  const visible = output.text.slice(0, output.text.indexOf('\n\n[Output truncated.'));
  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(visible) <= MAX_BYTES);
  assert.ok(!visible.includes('�'));
  assert.equal(visible.length, 1 + (MAX_BYTES - 2) / 2);
});

test('private temporary files are readable only by their owner', async t => {
  const path = await writePrivateTempFile('pi-shared-test-', 'full.txt', 'complete');
  t.after(() => rm(dirname(path), { recursive: true, force: true }));
  assert.equal(await readFile(path, 'utf8'), 'complete');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
});
