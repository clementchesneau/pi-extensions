import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProgram } from './process.js';

// --ignore-config keeps a personal yt-dlp configuration from adding cookies or other options.
const BASE = [
  '--ignore-config',
  '--no-cookies',
  '--no-cookies-from-browser',
  '--no-playlist',
  '--no-warnings',
  '--no-progress',
];
// Small files: at most 480 pixels high, or the smallest format a site offers. H.264 in MP4 comes
// first: seeking in it over the network takes seconds where VP9 or AV1 streams take tens.
const DOWNLOAD_FORMAT =
  'bv*[height<=480][vcodec^=avc1]+ba[ext=m4a]/b[height<=480][ext=mp4]/bv*[height<=480]+ba/b[height<=480]/wv*+ba/w';
const STREAM_FORMAT = 'bv*[height<=480][vcodec^=avc1]/b[height<=480][ext=mp4]/bv*[height<=480]/b[height<=480]/wv*/w';

function failure(stderr) {
  const lines = stderr.trim().split('\n');
  const line =
    lines
      .findLast(text => text.startsWith('ERROR:'))
      ?.slice(6)
      .trim() ||
    lines.at(-1) ||
    'unknown error';
  let hint = '';
  if (/logged[- ]?in|log ?in|sign ?in|cookies|private|age[- ]restricted|members[- ]only/i.test(line)) {
    hint = ' Video that requires being logged in is not supported: no browser cookies are used.';
  } else if (/Unsupported URL|Unable to extract|Unable to download|HTTP Error 4\d\d/i.test(line)) {
    hint = ' If the site changed, updating yt-dlp may help (brew upgrade yt-dlp).';
  }
  return new Error(`yt-dlp could not read this video: ${line}${hint}`);
}

async function ytdlp(args, signal) {
  const result = await runProgram('yt-dlp', [...BASE, ...args], { signal });
  if (result.code !== 0) throw failure(result.stderr);
  return result.stdout;
}

/** @param {string} url @param {AbortSignal} [signal] */
export async function readInfo(url, signal) {
  // --flat-playlist keeps a channel or playlist URL from extracting every one of its videos.
  const info = JSON.parse((await ytdlp(['--flat-playlist', '-J', url], signal)) || 'null');
  if (!info) throw new Error('yt-dlp found no video at this URL.');
  if (info._type === 'playlist' || info._type === 'multi_video') {
    throw new Error('This URL is a playlist or a channel, not one video: open one of its videos.');
  }
  if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
    throw new Error('Live streams are not supported: open the recording once the stream is over.');
  }
  return info;
}

/**
 * Downloads the video, or only the span, in a small format. Returns the file path.
 * @param {string} url
 * @param {string} directory
 * @param {{ from: number, to: number } | undefined} span
 * @param {AbortSignal} [signal]
 */
export async function downloadVideo(url, directory, span, signal) {
  const args = ['-f', DOWNLOAD_FORMAT, '--merge-output-format', 'mp4', '--print', 'after_move:filepath'];
  if (span) args.push('--download-sections', `*${span.from}-${span.to}`);
  const output = await ytdlp([...args, '-o', join(directory, 'video.%(ext)s'), url], signal);
  const path = output.trim().split('\n').at(-1);
  if (!path) throw new Error('yt-dlp did not report the downloaded file.');
  return path;
}

/** Direct URL of a small video stream, for reading frames without a download. */
export async function streamUrl(url, signal) {
  const output = await ytdlp(['-g', '-f', STREAM_FORMAT, url], signal);
  const stream = output.trim().split('\n')[0];
  if (!stream) throw new Error('yt-dlp found no video stream at this URL.');
  return stream;
}

function matching(keys, wanted) {
  for (const language of wanted.filter(Boolean)) {
    const found = keys.find(key => key === language) ?? keys.find(key => key.split('-')[0] === language.split('-')[0]);
    if (found) return found;
  }
  return undefined;
}

/**
 * One caption track: manual subtitles in the video's language, in English or any other, then the
 * automatic captions of the original audio. Translated automatic tracks are never chosen.
 * @returns {{ language: string, automatic: boolean } | undefined}
 */
export function captionTrack(info) {
  const manual = Object.keys(info.subtitles ?? {}).filter(key => key !== 'live_chat');
  const chosen = matching(manual, [info.language, 'en']) ?? manual[0];
  if (chosen) return { language: chosen, automatic: false };
  const automatic = Object.keys(info.automatic_captions ?? {});
  const original =
    automatic.find(key => key === `${info.language}-orig`) ??
    automatic.find(key => key.endsWith('-orig')) ??
    matching(automatic, [info.language]);
  return original ? { language: original, automatic: true } : undefined;
}

/** Caption text of one track, or undefined when the site returned none. */
export async function downloadCaptions(url, track, directory, signal) {
  await ytdlp(
    [
      '--skip-download',
      track.automatic ? '--write-auto-subs' : '--write-subs',
      '--sub-langs',
      track.language,
      '--sub-format',
      'vtt/srt/best',
      '-o',
      join(directory, 'captions.%(ext)s'),
      url,
    ],
    signal,
  );
  const file = (await readdir(directory)).find(name => name.startsWith('captions.'));
  return file ? readFile(join(directory, file), 'utf8') : undefined;
}
