import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoTools } from '../packages/video/index.js';
import { VideoLibrary } from '../packages/video/library.js';

const installed = program => {
  try {
    execFileSync(program, ['-version'], { stdio: 'ignore' });
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
