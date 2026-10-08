import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVideoTools } from '../../packages/video/index.js';
import { VideoLibrary } from '../../packages/video/library.js';
import { TINY_IMAGES } from './tiny-images.mjs';

export const FAKES = fileURLToPath(new URL('./video-bin/', import.meta.url));
export const VISION = { model: { input: ['text', 'image'] } };
export const publicHost = async () => [{ address: '93.184.215.14', family: 4 }];
export const URL_SOURCE = 'https://www.youtube.com/watch?v=abc';
export const CAPTIONS =
  'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n\n00:11:00.000 --> 00:11:02.000\nIn the range\n';
export const info = (overrides = {}) => ({
  extractor_key: 'Youtube',
  title: 'Demo talk',
  uploader: 'Ana',
  duration: 80,
  description: 'About demos',
  webpage_url: URL_SOURCE,
  language: 'en',
  chapters: [
    { start_time: 0, title: 'Intro' },
    { start_time: 40, title: 'Demo' },
  ],
  subtitles: { en: [{}], 'de-DE': [{}] },
  automatic_captions: { 'en-orig': [{}], fr: [{}] },
  ...overrides,
});

/** Fake media programs on PATH, driven by a scenario; returns the tools and the call log. */
export async function setup(t, scenario = {}, { config = {}, path = FAKES, gemini } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-video-test-'));
  const log = join(directory, 'calls.jsonl');
  await writeFile(log, '');
  const file = join(directory, 'scenario.json');
  await writeFile(
    file,
    JSON.stringify({ log, jpeg: TINY_IMAGES['image/jpeg'].toString('base64'), captions: CAPTIONS, ...scenario }),
  );
  const saved = { PATH: process.env.PATH, PI_VIDEO_FAKE: process.env.PI_VIDEO_FAKE };
  process.env.PATH = `${path}${delimiter}${saved.PATH}`;
  process.env.PI_VIDEO_FAKE = file;
  const library = new VideoLibrary({ tmp: directory, resolve: publicHost });
  t.after(async () => {
    Object.assign(process.env, saved);
    await library.close();
    await rm(directory, { recursive: true, force: true });
  });
  const tools = Object.fromEntries(
    createVideoTools({ library, readConfig: async name => config[name], gemini }).map(tool => [tool.name, tool]),
  );
  const calls = async () =>
    (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  return { tools, calls, directory, library };
}
