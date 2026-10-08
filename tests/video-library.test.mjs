import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoLibrary } from '../packages/video/library.js';
import { FAKES, publicHost } from './fixtures/video-setup.mjs';

test('the sweep removes only dead sessions directories it created, and survives one it cannot remove', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-video-sweep-'));
  t.after(async () => {
    await chmod(join(root, 'pi-video-locked'), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const session = async (name, owner) => {
    await mkdir(join(root, name));
    if (owner !== undefined) await writeFile(join(root, name, 'owner'), owner);
  };
  await session('pi-video-locked', '999999998');
  await writeFile(join(root, 'pi-video-locked', 'kept'), 'x');
  await chmod(join(root, 'pi-video-locked'), 0o500);
  await session('pi-video-dead', '999999999');
  await session('pi-video-alive', String(process.pid));
  await session('pi-video-ownerless');
  await writeFile(join(root, 'pi-video-notes.txt'), 'not ours');
  await VideoLibrary.sweepOrphans(root);
  assert.deepEqual((await readdir(root)).sort(), [
    'pi-video-alive',
    'pi-video-locked',
    'pi-video-notes.txt',
    'pi-video-ownerless',
  ]);
});

test('a session directory that could not be created is created on the next attempt', async t => {
  const root = join(await mkdtemp(join(tmpdir(), 'pi-video-retry-')), 'later');
  t.after(() => rm(join(root, '..'), { recursive: true, force: true }));
  const library = new VideoLibrary({ tmp: root });
  await assert.rejects(library.workspace('x'), { code: 'ENOENT' });
  await mkdir(root);
  assert.match(await library.workspace('x'), /pi-video-.*\/\d+-x$/);
  await library.close();
});

test('a stream address is fetched again after an hour, since sites make them expire', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-video-stream-'));
  const log = join(directory, 'calls.jsonl');
  await writeFile(log, '');
  await writeFile(join(directory, 's.json'), JSON.stringify({ log, streamUrl: 'https://media.example/s.mp4' }));
  const saved = { PATH: process.env.PATH, PI_VIDEO_FAKE: process.env.PI_VIDEO_FAKE };
  process.env.PATH = `${FAKES}:${saved.PATH}`;
  process.env.PI_VIDEO_FAKE = join(directory, 's.json');
  let now = 0;
  const library = new VideoLibrary({ tmp: directory, resolve: publicHost, now: () => now });
  t.after(async () => {
    Object.assign(process.env, saved);
    await library.close();
    await rm(directory, { recursive: true, force: true });
  });
  const entry = /** @type {any} */ ({ kind: 'url', key: 'k', url: 'https://example.com/v' });
  await library.stream(entry);
  now = 30 * 60_000;
  await library.stream(entry);
  now = 61 * 60_000;
  await library.stream(entry);
  const lines = (await (await import('node:fs/promises')).readFile(log, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
});

test('a stream address on a private network is refused before ffmpeg reads it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-video-private-'));
  const log = join(directory, 'calls.jsonl');
  await writeFile(log, '');
  await writeFile(join(directory, 's.json'), JSON.stringify({ log, streamUrl: 'http://127.0.0.1/stream.mp4' }));
  const saved = { PATH: process.env.PATH, PI_VIDEO_FAKE: process.env.PI_VIDEO_FAKE };
  process.env.PATH = `${FAKES}:${saved.PATH}`;
  process.env.PI_VIDEO_FAKE = join(directory, 's.json');
  const library = new VideoLibrary({ tmp: directory });
  t.after(async () => {
    Object.assign(process.env, saved);
    await library.close();
    await rm(directory, { recursive: true, force: true });
  });
  const entry = /** @type {any} */ ({ kind: 'url', key: 'k', url: 'https://example.com/v' });
  await assert.rejects(library.stream(entry), /Non-public network address blocked/);
});
