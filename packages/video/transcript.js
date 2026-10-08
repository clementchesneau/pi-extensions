import { readFile } from 'node:fs/promises';
import { formatTimestamp } from './frames.js';
import { runProgram } from './process.js';

const WHISPER_LIMIT_MS = 30 * 60_000;
const ROLLING_GAP_SECONDS = 0.5;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&#39;': "'", '&quot;': '"' };

function seconds(text) {
  const match = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/.exec(text);
  if (!match) return Number.NaN;
  const [, hours = '0', minutes, secs, millis] = match;
  // Whole milliseconds first, so 1.360 stays 1.36 rather than 1.3599999.
  return (Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(secs) * 1000 + Number(millis)) / 1000;
}

const clean = line =>
  line
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|nbsp|#39|quot);/g, entity => ENTITIES[entity])
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Cues of WebVTT or SubRip captions, without markup. With `rolling`, for automatic captions that
 * repeat the lines of the cue just before, a line repeated from a cue that ends where this one
 * starts is kept once; spoken repetitions elsewhere stay.
 * @param {string} text
 * @param {{ rolling?: boolean }} [options]
 * @returns {{ start: number, end: number, text: string }[]}
 */
export function parseCaptions(text, { rolling = false } = {}) {
  const cues = [];
  let previous = { lines: [], end: Number.NEGATIVE_INFINITY };
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const timing = lines.findIndex(line => line.includes('-->'));
    if (timing < 0) continue;
    const [startText, endText] = lines[timing].split('-->');
    const textLines = lines
      .slice(timing + 1)
      .map(clean)
      .filter(Boolean);
    const [start, end] = [seconds(startText), seconds(endText)];
    const rolled = rolling && start - previous.end < ROLLING_GAP_SECONDS;
    const fresh = rolled ? textLines.filter(line => !previous.lines.includes(line)) : textLines;
    if (textLines.length) previous = { lines: textLines, end };
    if (fresh.length) cues.push({ start, end, text: fresh.join(' ') });
  }
  return cues.filter(cue => Number.isFinite(cue.start));
}

/**
 * One "[m:ss] text" line per cue overlapping the span.
 * @param {{ start: number, end: number, text: string }[]} cues
 * @param {{ from?: number, to?: number }} [span]
 */
export function formatTranscript(cues, { from = 0, to = Number.POSITIVE_INFINITY } = {}) {
  return cues
    .filter(cue => cue.end > from && cue.start < to)
    .map(cue => `[${formatTimestamp(cue.start)}] ${cue.text}`)
    .join('\n');
}

/**
 * Cues spoken in a 16 kHz WAV file, from whisper.cpp, shifted to video time.
 * @param {{ audio: string, model: string, prefix: string, offset: number }} job
 * @param {AbortSignal} [signal]
 */
export async function transcribe({ audio, model, prefix, offset }, signal) {
  const args = ['-m', model, '-f', audio, '-l', 'auto', '-osrt', '-of', prefix, '-np'];
  // CPU-only machines transcribe far slower than Apple Silicon.
  const result = await runProgram('whisper-cli', args, { signal, timeoutMs: WHISPER_LIMIT_MS });
  if (result.code !== 0) {
    // whisper-cli prints its error first, then its usage.
    const lines = result.stderr.trim().split('\n').filter(Boolean);
    const reason = lines.find(line => /error/i.test(line)) ?? lines.at(-1) ?? 'unknown error';
    throw new Error(`whisper-cli failed: ${reason.trim()}`);
  }
  const cues = parseCaptions(await readFile(`${prefix}.srt`, 'utf8'));
  return cues.map(cue => ({ ...cue, start: cue.start + offset, end: cue.end + offset }));
}
