import { runProgram } from './process.js';

// A local input may only read files, so a crafted playlist cannot fetch network resources, and a
// remote one only the network, so a crafted playlist cannot read local files.
const LOCAL = ['-protocol_whitelist', 'file'];
const REMOTE = ['-protocol_whitelist', 'http,https,tls,tcp,crypto,hls'];

/**
 * A media file or stream and the video time of its start: a downloaded part of a video starts
 * at the beginning of that part.
 * @typedef {{ input: string, offset: number }} Media
 */

const lastLine = text => text.trim().split('\n').at(-1) ?? '';
const inputOptions = input => (/^https?:/i.test(input) ? REMOTE : LOCAL);

async function ffmpeg(args, signal) {
  const result = await runProgram('ffmpeg', ['-hide_banner', '-nostdin', ...args], { signal });
  if (result.code !== 0) throw new Error(`ffmpeg failed: ${lastLine(result.stderr)}`);
  return result;
}

/** Seek and length options for a span of video time within a media input. */
function spanOptions(media, span) {
  if (!span) return [];
  return ['-ss', String(Math.max(0, span.from - media.offset)), '-t', String(span.to - span.from)];
}

/** @param {string} path @param {AbortSignal} [signal] */
export async function probe(path, signal) {
  const args = [
    '-v',
    'error',
    ...LOCAL,
    '-show_entries',
    'format=duration,format_name:stream=codec_type',
    '-of',
    'json',
    path,
  ];
  const result = await runProgram('ffprobe', args, { signal });
  if (result.code !== 0) throw new Error(`ffprobe cannot read ${path}: ${lastLine(result.stderr)}`);
  const data = JSON.parse(result.stdout);
  const types = (data.streams ?? []).map(stream => stream.codec_type);
  return {
    duration: Number(data.format?.duration) || 0,
    formatName: String(data.format?.format_name ?? ''),
    hasVideo: types.includes('video'),
    hasAudio: types.includes('audio'),
  };
}

/**
 * Video times of the scene changes within the span.
 * @param {Media} media
 * @param {{ from: number, to: number } | undefined} span
 * @param {AbortSignal} [signal]
 */
export async function sceneCuts(media, span, signal) {
  const args = [...spanOptions(media, span), ...inputOptions(media.input), '-i', media.input, '-an'];
  args.push('-vf', "select='gt(scene,0.3)',showinfo", '-fps_mode', 'vfr', '-f', 'null', '-');
  const { stderr } = await ffmpeg(args, signal);
  const start = span ? Math.max(span.from, media.offset) : media.offset;
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map(match => start + Number(match[1]));
}

/**
 * Writes the frame at a video time as a JPEG at most `width` pixels wide.
 * @param {Media} media
 * @param {{ time: number, width: number, output: string }} frame
 * @param {AbortSignal} [signal]
 */
export async function extractFrame(media, { time, width, output }, signal) {
  const seek = String(Math.max(0, time - media.offset));
  const args = ['-loglevel', 'error', '-y', ...inputOptions(media.input), '-ss', seek, '-i', media.input];
  args.push('-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', '4', output);
  await ffmpeg(args, signal);
}

/** Writes the span's audio as 16 kHz mono WAV, the input whisper.cpp expects. */
export async function extractAudio(media, span, output, signal) {
  const args = ['-loglevel', 'error', '-y', ...spanOptions(media, span), ...inputOptions(media.input)];
  args.push('-i', media.input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output);
  await ffmpeg(args, signal);
}

/** Copies the span into its own file without re-encoding. */
export async function cutClip(media, span, output, signal) {
  const args = ['-loglevel', 'error', '-y', ...spanOptions(media, span), ...inputOptions(media.input)];
  args.push('-i', media.input, '-c', 'copy', output);
  await ffmpeg(args, signal);
}
