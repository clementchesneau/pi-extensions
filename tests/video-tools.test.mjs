import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoTools } from '../packages/video/index.js';
import { VideoLibrary } from '../packages/video/library.js';
import { FAKES, info, publicHost, setup, URL_SOURCE, VISION } from './fixtures/video-setup.mjs';

const images = result => result.content.filter(block => block.type === 'image');
const labels = result =>
  result.content.filter(block => block.type === 'text' && block.text.startsWith('Frame at')).map(block => block.text);
const ctxIn = cwd => ({ ...VISION, cwd });

test('video_overview reads a video URL through its platform subtitles and scene-aligned frames', async t => {
  const { tools, calls } = await setup(t, { info: info(), cuts: [13] });
  const updates = [];
  const result = await tools.video_overview.execute(
    '1',
    { source: URL_SOURCE },
    undefined,
    update => updates.push(update),
    VISION,
  );
  const text = result.content[0].text;
  assert.match(text, /untrusted/i);
  assert.match(text, /Title: Demo talk\nSource: https:\/\/www\.youtube\.com\/watch\?v=abc\nDuration: 1:20\nBy: Ana/);
  assert.match(text, /Chapters:\n- 0:00 Intro\n- 0:40 Demo/);
  assert.match(text, /Transcript \(platform subtitles, en\):\n\[0:01\] Hello/);
  assert.equal(images(result).length, 8);
  assert.deepEqual(labels(result), [
    'Frame at 0:05',
    'Frame at 0:13',
    'Frame at 0:25',
    'Frame at 0:35',
    'Frame at 0:45',
    'Frame at 0:55',
    'Frame at 1:05',
    'Frame at 1:15',
  ]);
  assert.equal(images(result)[0].mimeType, 'image/jpeg');
  assert.deepEqual(result.details.frames, [5, 13.2, 25, 35, 45, 55, 65, 75]);
  assert.equal(result.details.transcript, 'platform subtitles');
  const ytdlp = (await calls()).filter(call => call.program === 'yt-dlp');
  for (const call of ytdlp) {
    assert.ok(call.args.includes('--ignore-config'), call.args.join(' '));
    assert.ok(call.args.includes('--no-cookies'), call.args.join(' '));
    assert.ok(call.args.includes('--no-cookies-from-browser'), call.args.join(' '));
  }
  const subtitles = ytdlp.find(call => call.args.includes('--skip-download'));
  assert.equal(subtitles.args[subtitles.args.indexOf('--sub-langs') + 1], 'en');
  assert.ok(subtitles.args.includes('--write-subs'));
  assert.ok(!(await calls()).some(call => call.program === 'whisper-cli'));
  assert.ok(updates.some(update => /Downloading/.test(update.content[0].text)));
});

test('without subtitles, whisper transcribes when a model is configured, and its absence is explained', async t => {
  const bare = info({ subtitles: {}, automatic_captions: {} });
  const srt = '1\n00:00:02,000 --> 00:00:04,000\n Spoken words\n';
  const probe = { format: { duration: '80' }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] };
  const configured = await setup(
    t,
    { info: bare, probe, whisperSrt: srt },
    { config: { WHISPER_MODEL: '/models/ggml.bin' } },
  );
  const result = await configured.tools.video_overview.execute(
    '1',
    { source: URL_SOURCE },
    undefined,
    undefined,
    VISION,
  );
  assert.match(result.content[0].text, /Transcript \(whisper\):\n\[0:02\] Spoken words/);
  const whisper = (await configured.calls()).find(call => call.program === 'whisper-cli');
  assert.equal(whisper.args[whisper.args.indexOf('-m') + 1], '/models/ggml.bin');

  const missing = await setup(t, { info: bare });
  const unexplained = await missing.tools.video_overview.execute(
    '2',
    { source: URL_SOURCE },
    undefined,
    undefined,
    VISION,
  );
  assert.match(unexplained.content[0].text, /No transcript:.*no subtitles.*WHISPER_MODEL/s);
  assert.equal(unexplained.details.transcript, 'none');
  assert.ok(!(await missing.calls()).some(call => call.program === 'whisper-cli'));
});

test('a video without an audio track says so instead of running whisper', async t => {
  const silent = { format: { duration: '5' }, streams: [{ codec_type: 'video' }] };
  const { tools, calls } = await setup(
    t,
    { info: info({ subtitles: {}, automatic_captions: {}, duration: null }), probe: silent },
    { config: { WHISPER_MODEL: '/models/ggml.bin' } },
  );
  const result = await tools.video_overview.execute('1', { source: URL_SOURCE }, undefined, undefined, VISION);
  assert.match(result.content[0].text, /No transcript: the video has no audio track\./);
  assert.match(result.content[0].text, /Duration: 0:05/);
  const log = await calls();
  assert.ok(!log.some(call => call.program === 'whisper-cli'));
  assert.ok(!log.some(call => call.program === 'ffmpeg' && call.args.includes('pcm_s16le')));
});

test('downloads and streams prefer H.264 in MP4, which seeks fast over the network', async t => {
  const short = await setup(t, { info: info() });
  await short.tools.video_overview.execute('1', { source: URL_SOURCE }, undefined, undefined, VISION);
  const long = await setup(t, { info: info({ duration: 3600 }), streamUrl: 'https://media.example/stream.mp4' });
  await long.tools.video_overview.execute('2', { source: URL_SOURCE }, undefined, undefined, VISION);
  const format = call => call.args[call.args.indexOf('-f') + 1];
  const download = (await short.calls()).find(call => call.program === 'yt-dlp' && call.args.includes('--print'));
  const stream = (await long.calls()).find(call => call.program === 'yt-dlp' && call.args.includes('-g'));
  for (const call of [download, stream]) assert.match(format(call), /^bv\*\[height<=480\]\[vcodec\^=avc1\]/);
});

test('a local file is probed and transcribed without yt-dlp, relative to the working directory', async t => {
  const probe = { format: { duration: '20.0' }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] };
  const { tools, calls, directory } = await setup(
    t,
    { probe, whisperSrt: '1\n00:00:01,000 --> 00:00:02,000\n Local speech\n' },
    { config: { WHISPER_MODEL: '/models/ggml.bin' } },
  );
  await mkdir(join(directory, 'work'));
  await writeFile(join(directory, 'work', 'clip.mp4'), 'video');
  const result = await tools.video_overview.execute(
    '1',
    { source: 'clip.mp4' },
    undefined,
    undefined,
    ctxIn(join(directory, 'work')),
  );
  assert.match(result.content[0].text, /Title: clip\.mp4\nSource: .*clip\.mp4\nDuration: 0:20/);
  assert.match(result.content[0].text, /\[0:01\] Local speech/);
  assert.equal(images(result).length, 8);
  assert.ok(!(await calls()).some(call => call.program === 'yt-dlp'));
  const frame = (await calls()).find(call => call.program === 'ffmpeg' && call.args.at(-1).endsWith('.jpg'));
  assert.ok(frame.args.includes('-protocol_whitelist') && frame.args.includes('file'));
  await assert.rejects(
    tools.video_overview.execute('2', { source: 'missing.mp4' }, undefined, undefined, ctxIn(directory)),
    /No video file at .*missing\.mp4/,
  );
});

test('a video over 30 minutes gets subtitles and an evenly spaced overview without a download', async t => {
  const { tools, calls } = await setup(t, {
    info: info({ duration: 3600 }),
    streamUrl: 'https://media.example/stream.mp4',
    cuts: [12],
  });
  const result = await tools.video_overview.execute('1', { source: URL_SOURCE }, undefined, undefined, VISION);
  assert.deepEqual(result.details.frames, [225, 675, 1125, 1575, 2025, 2475, 2925, 3375]);
  assert.match(result.content[0].text, /over 30 minutes.*from and to/s);
  const log = await calls();
  assert.ok(!log.some(call => call.program === 'yt-dlp' && call.args.includes('--print')));
  assert.ok(!log.some(call => call.program === 'ffmpeg' && call.args.includes('null')));
  const frames = log.filter(call => call.program === 'ffmpeg' && call.args.at(-1).endsWith('.jpg'));
  assert.ok(frames.every(call => call.args.includes('https://media.example/stream.mp4')));
});

test('a range downloads and transcribes only that part, and frames and transcript stay inside it', async t => {
  const { tools, calls } = await setup(t, { info: info({ duration: 3600 }), cuts: [] });
  const result = await tools.video_overview.execute(
    '1',
    { source: URL_SOURCE, from: '10:00', to: '12:00' },
    undefined,
    undefined,
    VISION,
  );
  const download = (await calls()).find(call => call.program === 'yt-dlp' && call.args.includes('--print'));
  assert.equal(download.args[download.args.indexOf('--download-sections') + 1], '*600-720');
  assert.deepEqual(result.details.frames, [607.5, 622.5, 637.5, 652.5, 667.5, 682.5, 697.5, 712.5]);
  assert.match(result.content[0].text, /Range: 10:00 to 12:00/);
  assert.match(result.content[0].text, /\[11:00\] In the range/);
  assert.doesNotMatch(result.content[0].text, /Hello/);
  await assert.rejects(
    tools.video_overview.execute('2', { source: URL_SOURCE, from: '12:00', to: '10:00' }, undefined, undefined, VISION),
    /from must be before to/,
  );
});

test('a text-only model gets the transcript and metadata without frames', async t => {
  const { tools, calls } = await setup(t, { info: info() });
  const result = await tools.video_overview.execute('1', { source: URL_SOURCE }, undefined, undefined, {
    model: { input: ['text'] },
  });
  assert.equal(images(result).length, 0);
  assert.match(result.content[0].text, /current model does not accept images/);
  assert.match(result.content[0].text, /\[0:01\] Hello/);
  assert.ok(!(await calls()).some(call => call.program === 'ffmpeg'));
});

test('URLs on private networks are refused before yt-dlp runs', async t => {
  const { calls, library } = await setup(t, { info: info() });
  const tools = Object.fromEntries(
    createVideoTools({ library: new VideoLibrary({ tmp: tmpdir() }), readConfig: async () => undefined }).map(tool => [
      tool.name,
      tool,
    ]),
  );
  t.after(() => library.close());
  await assert.rejects(
    tools.video_overview.execute('1', { source: 'http://127.0.0.1/video.mp4' }, undefined, undefined, VISION),
    /Non-public network address blocked/,
  );
  await assert.rejects(
    tools.video_overview.execute('2', { source: 'ftp://example.com/v.mp4' }, undefined, undefined, VISION),
    /Only public HTTP\(S\) URLs/,
  );
  assert.deepEqual(await calls(), []);
});

test('yt-dlp failures explain logins, outdated extractors and missing programs', async t => {
  const login = await setup(t, { ytdlpError: '[vimeo] 1: The web client only works when logged-in. Use --cookies' });
  await assert.rejects(
    login.tools.video_overview.execute('1', { source: 'https://vimeo.com/1' }, undefined, undefined, VISION),
    /only works when logged-in.*requires being logged in is not supported.*no browser cookies/s,
  );
  const outdated = await setup(t, { ytdlpError: '[tiktok] 2: Unable to extract universal data' });
  await assert.rejects(
    outdated.tools.video_overview.execute(
      '1',
      { source: 'https://www.tiktok.com/@a/video/2' },
      undefined,
      undefined,
      VISION,
    ),
    /Unable to extract.*brew upgrade yt-dlp/s,
  );
  const empty = await mkdtemp(join(tmpdir(), 'pi-video-empty-path-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const missing = await setup(t, { info: info() }, { path: empty });
  process.env.PATH = empty;
  await assert.rejects(
    missing.tools.video_overview.execute('1', { source: URL_SOURCE }, undefined, undefined, VISION),
    /yt-dlp is not installed.*brew install yt-dlp/s,
  );
});

test('video_frames returns labelled frames at the requested moments in higher resolution', async t => {
  const { tools, calls } = await setup(t, { info: info(), streamUrl: 'https://media.example/stream.mp4' });
  const result = await tools.video_frames.execute(
    '1',
    { source: URL_SOURCE, timestamps: ['0:10', '62.5'] },
    undefined,
    undefined,
    VISION,
  );
  assert.deepEqual(labels(result), ['Frame at 0:10', 'Frame at 1:02']);
  assert.equal(images(result).length, 2);
  const frames = (await calls()).filter(call => call.program === 'ffmpeg');
  assert.ok(frames.every(call => call.args.some(arg => arg.includes('1280'))));
  await assert.rejects(
    tools.video_frames.execute('2', { source: URL_SOURCE, timestamps: ['1:30'] }, undefined, undefined, VISION),
    /1:30 is past the end of the video \(1:20\)/,
  );
  await assert.rejects(
    tools.video_frames.execute('3', { source: URL_SOURCE, timestamps: ['0:10'] }, undefined, undefined, {
      model: { input: ['text'] },
    }),
    /current model does not accept images/,
  );
});

test('the session directory is private, removed at shutdown, and orphans of dead sessions are swept', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-video-sweep-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = new VideoLibrary({ tmp: root, resolve: publicHost });
  const directory = await library.directory();
  assert.ok((await readdir(root)).includes(directory.split('/').at(-1)));
  await library.close();
  assert.deepEqual(await readdir(root), []);

  await mkdir(join(root, 'pi-video-dead'));
  await writeFile(join(root, 'pi-video-dead', '.pi-video-owner'), '999999999');
  await mkdir(join(root, 'pi-video-alive'));
  await writeFile(join(root, 'pi-video-alive', '.pi-video-owner'), String(process.pid));
  await mkdir(join(root, 'unrelated'));
  await VideoLibrary.sweepOrphans(root);
  assert.deepEqual((await readdir(root)).sort(), ['pi-video-alive', 'unrelated']);
});

const AUDIO_PROBE = {
  format: { duration: '9', format_name: 'mov,mp4' },
  streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
};

test('a part of a video of unknown length keeps the length unknown for later calls', async t => {
  const reel = info({ duration: null, chapters: [], subtitles: {}, automatic_captions: {} });
  const { tools } = await setup(t, { info: reel, probe: AUDIO_PROBE });
  const part = await tools.video_overview.execute('1', { source: URL_SOURCE, to: '3' }, undefined, undefined, VISION);
  assert.match(part.content[0].text, /Duration: unknown\nBy: Ana\nRange: 0:00 to 0:03/);
  const later = await tools.video_frames.execute(
    '2',
    { source: URL_SOURCE, timestamps: ['6'] },
    undefined,
    undefined,
    VISION,
  );
  assert.deepEqual(labels(later), ['Frame at 0:06']);
  await assert.rejects(
    tools.video_overview.execute(
      '3',
      { source: 'https://www.youtube.com/watch?v=other', from: '2' },
      undefined,
      undefined,
      VISION,
    ),
    /length of this video is unknown: give both from and to/,
  );
});

test('video_frames downloads a short video rather than reading its stream, and reuses that download', async t => {
  const { tools, calls } = await setup(t, { info: info(), streamUrl: 'https://media.example/stream.mp4' });
  const updates = [];
  await tools.video_frames.execute(
    '1',
    { source: URL_SOURCE, timestamps: ['0:10'] },
    undefined,
    u => updates.push(u),
    VISION,
  );
  await tools.video_overview.execute('2', { source: URL_SOURCE }, undefined, undefined, VISION);
  await tools.video_frames.execute('3', { source: URL_SOURCE, timestamps: ['0:20'] }, undefined, undefined, VISION);
  const log = await calls();
  assert.equal(log.filter(call => call.program === 'yt-dlp' && call.args.includes('--print')).length, 1);
  assert.ok(!log.some(call => call.program === 'yt-dlp' && call.args.includes('-g')));
  assert.ok(updates.some(update => /Downloading/.test(update.content[0].text)));
});

test('in a long video, frames the stream refuses become a note and the transcript is kept', async t => {
  const { tools, calls } = await setup(t, {
    info: info({ duration: 3600 }),
    streamUrl: 'https://media.example/stream.mp4',
    frameError: 'Server returned 403 Forbidden',
  });
  const result = await tools.video_overview.execute('1', { source: URL_SOURCE }, undefined, undefined, VISION);
  assert.match(result.content[0].text, /\[0:01\] Hello/);
  assert.match(result.content[0].text, /8 of 8 frames could not be read: ffmpeg failed: .*403 Forbidden/);
  const remote = (await calls()).find(call => call.program === 'ffmpeg');
  assert.equal(remote.args[remote.args.indexOf('-protocol_whitelist') + 1], 'http,https,tls,tcp,crypto,hls');
});

test('failed subtitles and a failed whisper run become notes with the useful error line', async t => {
  const usage = 'error: model file not found\n\nusage: whisper-cli [options]\n  -vo N, --vad-samples-overlap\n';
  const { tools } = await setup(
    t,
    {
      info: info(),
      probe: AUDIO_PROBE,
      subtitleError: 'Unable to download video subtitles: HTTP Error 429',
      whisperError: usage,
    },
    { config: { WHISPER_MODEL: '/nonexistent' } },
  );
  const result = await tools.video_overview.execute('1', { source: URL_SOURCE }, undefined, undefined, VISION);
  assert.match(result.content[0].text, /Subtitles could not be downloaded: .*HTTP Error 429/);
  assert.match(result.content[0].text, /No transcript: whisper-cli failed: error: model file not found/);
  assert.equal(result.details.transcript, 'none');
  assert.equal(images(result).length, 8);
});

test('a missing whisper-cli becomes a note with the command to install it', async t => {
  // Every program but whisper-cli, and node for the fakes themselves.
  const partial = await mkdtemp(join(tmpdir(), 'pi-video-no-whisper-'));
  t.after(() => rm(partial, { recursive: true, force: true }));
  for (const program of ['yt-dlp', 'ffmpeg', 'ffprobe']) await symlink(join(FAKES, program), join(partial, program));
  await symlink(process.execPath, join(partial, 'node'));
  const bare = info({ subtitles: {}, automatic_captions: {} });
  const { tools } = await setup(
    t,
    { info: bare, probe: AUDIO_PROBE },
    { config: { WHISPER_MODEL: '/models/ggml.bin' }, path: partial },
  );
  process.env.PATH = partial;
  const result = await tools.video_overview.execute('1', { source: URL_SOURCE }, undefined, undefined, VISION);
  assert.match(result.content[0].text, /No transcript: whisper-cli is not installed.*brew install whisper\.cpp/);
  assert.equal(images(result).length, 8);
});

test('playlists, channels and live streams are refused, and metadata never expands a playlist', async t => {
  const playlist = await setup(t, { info: { _type: 'playlist', title: 'Uploads' } });
  await assert.rejects(
    playlist.tools.video_overview.execute(
      '1',
      { source: 'https://www.youtube.com/@cs50' },
      undefined,
      undefined,
      VISION,
    ),
    /playlist or a channel, not one video/,
  );
  const metadata = (await playlist.calls()).find(call => call.args.includes('-J'));
  assert.ok(metadata.args.includes('--flat-playlist'));
  const live = await setup(t, { info: info({ live_status: 'is_live', duration: null }) });
  await assert.rejects(
    live.tools.video_overview.execute('1', { source: URL_SOURCE }, undefined, undefined, VISION),
    /Live streams are not supported/,
  );
});

test('a local file must be a real video: images and text read as video by ffprobe are refused', async t => {
  for (const format_name of ['png_pipe', 'tty', 'image2']) {
    const probe = { format: { duration: '5', format_name }, streams: [{ codec_type: 'video' }] };
    const { tools, directory } = await setup(t, { probe });
    await writeFile(join(directory, 'file.bin'), 'x');
    await assert.rejects(
      tools.video_overview.execute('1', { source: 'file.bin' }, undefined, undefined, { ...VISION, cwd: directory }),
      /is not a video file/,
    );
  }
});

test('an audio file with embedded cover art is not a video', async t => {
  const probe = {
    format: { duration: '180', format_name: 'mp3' },
    streams: [{ codec_type: 'audio' }, { codec_type: 'video', disposition: { attached_pic: 1 } }],
  };
  const { tools, directory } = await setup(t, { probe });
  await writeFile(join(directory, 'song.mp3'), 'x');
  await assert.rejects(
    tools.video_overview.execute('1', { source: 'song.mp3' }, undefined, undefined, { ...VISION, cwd: directory }),
    /song\.mp3 has no video stream/,
  );
});

test('automatic captions lose rolling repeats while manual subtitles keep repeated words', async t => {
  const rolling = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nNo\n\n00:00:02.000 --> 00:00:03.000\nNo\nmore\n';
  const automatic = await setup(t, { info: info({ subtitles: {} }), captions: rolling });
  const auto = await automatic.tools.video_overview.execute('1', { source: URL_SOURCE }, undefined, undefined, {
    model: { input: ['text'] },
  });
  assert.match(auto.content[0].text, /Transcript \(automatic subtitles, en-orig\):\n\[0:01\] No\n\[0:02\] more\n/);
  const manual = await setup(t, { info: info(), captions: rolling });
  const kept = await manual.tools.video_overview.execute('1', { source: URL_SOURCE }, undefined, undefined, {
    model: { input: ['text'] },
  });
  assert.match(kept.content[0].text, /\[0:01\] No\n\[0:02\] No more\n/);
});

test('local paths accept ~ for the home directory and a leading @, like Pi tools', async t => {
  const { tools, calls } = await setup(t, { probe: AUDIO_PROBE });
  await assert.rejects(
    tools.video_overview.execute('1', { source: '@~/pi-video-missing-file.mp4' }, undefined, undefined, VISION),
    new RegExp(`No video file at ${process.env.HOME}/pi-video-missing-file\\.mp4`),
  );
  assert.deepEqual(await calls(), []);
});

test('Esc during a download stops yt-dlp and the next call downloads again', async t => {
  const { tools, calls, directory } = await setup(t, { info: info(), downloadDelayMs: 5000, pidProgram: 'yt-dlp' });
  const pidFile = join(directory, 'yt-dlp.pid');
  const scenarioFile = process.env.PI_VIDEO_FAKE;
  const scenario = JSON.parse(await readFile(scenarioFile, 'utf8'));
  await writeFile(scenarioFile, JSON.stringify({ ...scenario, pidFile }));
  const controller = new AbortController();
  const running = tools.video_overview.execute('1', { source: URL_SOURCE }, controller.signal, undefined, VISION);
  await new Promise(resolve => setTimeout(resolve, 600));
  const pid = Number(await readFile(pidFile, 'utf8'));
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await writeFile(scenarioFile, JSON.stringify({ ...scenario, downloadDelayMs: 0 }));
  await tools.video_overview.execute('2', { source: URL_SOURCE }, undefined, undefined, VISION);
  assert.equal((await calls()).filter(call => call.program === 'yt-dlp' && call.args.includes('--print')).length, 2);
});

test('parallel calls on one source share its metadata and download', async t => {
  const { tools, calls } = await setup(t, { info: info(), downloadDelayMs: 200 });
  await Promise.all([
    tools.video_overview.execute('1', { source: URL_SOURCE }, undefined, undefined, VISION),
    tools.video_frames.execute('2', { source: URL_SOURCE, timestamps: ['0:30'] }, undefined, undefined, VISION),
  ]);
  const ytdlp = (await calls()).filter(call => call.program === 'yt-dlp');
  assert.equal(ytdlp.filter(call => call.args.includes('-J')).length, 1);
  assert.equal(ytdlp.filter(call => call.args.includes('--print')).length, 1);
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a cancelled call stops waiting at once, while the other call keeps the shared download', async t => {
  for (const cancelled of [0, 1]) {
    await t.test(`cancelling call ${cancelled + 1}`, async st => {
      const { tools, calls } = await setup(st, { info: info(), downloadDelayMs: 3000 });
      const controller = new AbortController();
      const signals = [undefined, undefined];
      signals[cancelled] = controller.signal;
      const runs = [
        tools.video_overview.execute('1', { source: URL_SOURCE }, signals[0], undefined, VISION),
        tools.video_frames.execute('2', { source: URL_SOURCE, timestamps: ['0:30'] }, signals[1], undefined, VISION),
      ];
      await pause(600);
      const started = Date.now();
      controller.abort();
      const stopped = runs[cancelled].then(
        () => assert.fail('the cancelled call completed'),
        error => ({ name: error.name, after: Date.now() - started }),
      );
      const [cancelledRun, other] = await Promise.all([stopped, runs[1 - cancelled]]);
      assert.equal(cancelledRun.name, 'AbortError');
      assert.ok(cancelledRun.after < 1000, `the cancelled call waited ${cancelledRun.after} ms`);
      assert.equal(images(other).length, cancelled === 0 ? 1 : 8);
      const downloads = (await calls()).filter(call => call.program === 'yt-dlp' && call.args.includes('--print'));
      assert.equal(downloads.length, 1);
    });
  }
});

test('a call cancelled before it starts runs nothing and gets no result, even one already known', async t => {
  const { tools, calls } = await setup(t, { info: info() });
  const cancelled = AbortSignal.abort();
  const text = { model: { input: ['text'] } };
  await assert.rejects(tools.video_overview.execute('1', { source: URL_SOURCE }, cancelled, undefined, text), {
    name: 'AbortError',
  });
  await pause(300);
  assert.deepEqual(await calls(), []);
  await tools.video_overview.execute('2', { source: URL_SOURCE }, undefined, undefined, text);
  await assert.rejects(tools.video_overview.execute('3', { source: URL_SOURCE }, cancelled, undefined, text), {
    name: 'AbortError',
  });
});

test('a shared download stops once every call waiting for it is cancelled', async t => {
  // Without subtitles, the download is the last yt-dlp run: the one whose process is recorded.
  const bare = info({ subtitles: {}, automatic_captions: {} });
  const { tools, directory } = await setup(t, { info: bare, downloadDelayMs: 5000, pidProgram: 'yt-dlp' });
  const pidFile = join(directory, 'yt-dlp.pid');
  const scenarioFile = process.env.PI_VIDEO_FAKE;
  await writeFile(scenarioFile, JSON.stringify({ ...JSON.parse(await readFile(scenarioFile, 'utf8')), pidFile }));
  const controllers = [new AbortController(), new AbortController()];
  const runs = [
    tools.video_overview.execute('1', { source: URL_SOURCE }, controllers[0].signal, undefined, VISION),
    tools.video_frames.execute(
      '2',
      { source: URL_SOURCE, timestamps: ['0:30'] },
      controllers[1].signal,
      undefined,
      VISION,
    ),
  ];
  await pause(600);
  const pid = Number(await readFile(pidFile, 'utf8'));
  for (const [index, controller] of controllers.entries()) {
    assert.doesNotThrow(() => process.kill(pid, 0), 'the download runs while a call waits for it');
    controller.abort();
    await assert.rejects(runs[index], { name: 'AbortError' });
    await pause(100);
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('a text-only model with subtitles downloads nothing and announces no download', async t => {
  const { tools, calls } = await setup(t, { info: info() });
  const updates = [];
  await tools.video_overview.execute('1', { source: URL_SOURCE }, undefined, u => updates.push(u), {
    model: { input: ['text'] },
  });
  assert.ok(!updates.some(update => /Downloading/.test(update.content[0].text)));
  assert.ok(!(await calls()).some(call => call.args.includes('--print')));
});
