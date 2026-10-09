import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoTools } from '../packages/video/index.js';
import { VideoLibrary } from '../packages/video/library.js';
import { encodeClip } from '../packages/video/media.js';
import { downloadVideo } from '../packages/video/ytdlp.js';

const installed = (program, flag = '-version') => {
  try {
    execFileSync(program, [flag], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

test(
  'with the real ffmpeg, a local video is probed, its scene cut found and its frames extracted',
  { skip: !(installed('ffmpeg') && installed('ffprobe')) && 'ffmpeg and ffprobe are not installed' },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-video-ffmpeg-'));
    const library = new VideoLibrary({ tmp: directory });
    t.after(async () => {
      await library.close();
      await rm(directory, { recursive: true, force: true });
    });
    // Three seconds of red, then three of blue: one scene cut at 3 s.
    const colors = ['red', 'blue'].flatMap(color => ['-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=3:r=25`]);
    execFileSync('ffmpeg', [
      '-v',
      'error',
      ...colors,
      '-filter_complex',
      '[0][1]concat=n=2:v=1:a=0',
      join(directory, 'cut.mp4'),
    ]);
    const [overview, frames] = createVideoTools({ library, readConfig: async () => undefined });
    const ctx = { model: { input: ['text', 'image'] }, cwd: directory };
    const result = await overview.execute('1', { source: 'cut.mp4' }, undefined, undefined, ctx);
    assert.deepEqual(result.details.frames, [1, 3.2, 5]);
    assert.equal(result.details.duration, 6);
    const images = result.content.filter(block => block.type === 'image');
    assert.equal(images.length, 3);
    for (const image of images)
      assert.deepEqual([...Buffer.from(image.data, 'base64').subarray(0, 3)], [0xff, 0xd8, 0xff]);
    const detail = await frames.execute('2', { source: 'cut.mp4', timestamps: ['4.5'] }, undefined, undefined, ctx);
    assert.equal(detail.content.filter(block => block.type === 'image').length, 1);
    assert.match(overview.description + result.content[0].text, /No transcript/);
  },
);

test(
  'with the real ffmpeg, a clip for Gemini holds only its span, even before the first keyframe of the span',
  { skip: !installed('ffmpeg') && 'ffmpeg is not installed' },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-video-clip-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    // Red then blue, with a single keyframe at 0: a stream copy of 4-5 s would carry red frames.
    const colors = ['red', 'blue'].flatMap(color => ['-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=3:r=25`]);
    const source = join(directory, 'source.mp4');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      ...colors,
      '-filter_complex',
      '[0][1]concat=n=2:v=1:a=0',
      '-g',
      '1000',
      '-metadata',
      'location=+48.85+002.35/',
      source,
    ]);
    const clip = join(directory, 'clip.mp4');
    await encodeClip({ input: source, offset: 0 }, { from: 4, to: 5 }, clip);
    const raw = execFileSync('ffmpeg', [
      '-v',
      'error',
      '-ignore_editlist',
      '1',
      '-i',
      clip,
      '-vf',
      'scale=1:1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ]);
    const frames = raw.length / 3;
    assert.ok(frames >= 24 && frames <= 26, `${frames} frames`);
    for (let index = 0; index < raw.length; index += 3)
      assert.ok(raw[index] < 80 && raw[index + 2] > 160, `frame ${index / 3} is not blue`);
    const tags = execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format_tags',
      '-of',
      'json',
      clip,
    ]).toString();
    assert.doesNotMatch(tags, /location/);
  },
);

/** Serves one file over HTTP with byte ranges, as video hosts do, so ffmpeg can seek in it. */
async function serveFile(t, path, type) {
  const data = await readFile(path);
  const server = createServer((request, response) => {
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : data.length - 1;
    response.writeHead(range ? 206 : 200, {
      'content-type': type,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${data.length}` } : {}),
    });
    response.end(request.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => server.close());
  return `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/video`;
}

test(
  'with the real yt-dlp, a downloaded part starts exactly at from, even in a container without edit lists',
  {
    skip: !(installed('ffmpeg') && installed('yt-dlp', '--version')) && 'yt-dlp and ffmpeg are not installed',
  },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-video-part-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    // Red then blue, with a single keyframe at 0, in Matroska: a copy of 4-5 s would start with red.
    const colors = ['red', 'blue'].flatMap(color => ['-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=4:r=25`]);
    const source = join(directory, 'source.mkv');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      ...colors,
      '-filter_complex',
      '[0][1]concat=n=2:v=1:a=0',
      '-g',
      '1000',
      source,
    ]);
    const url = await serveFile(t, source, 'video/x-matroska');
    const part = await downloadVideo(url, directory, { from: 4, to: 5 });
    const raw = execFileSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      part,
      '-vf',
      'scale=1:1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ]);
    const frames = raw.length / 3;
    assert.ok(frames >= 24 && frames <= 26, `${frames} frames`);
    for (let index = 0; index < raw.length; index += 3)
      assert.ok(raw[index] < 80 && raw[index + 2] > 160, `frame ${index / 3} is not blue`);
  },
);
