import { join } from 'node:path';
import { formatTimestamp, overviewTimes, parseTimestamp } from './frames.js';
import { extractAudio, extractFrame, probe, sceneCuts } from './media.js';
import { formatTranscript, transcribe } from './transcript.js';

export const LONG_VIDEO_SECONDS = 30 * 60;
const OVERVIEW_WIDTH = 768;
const DETAIL_WIDTH = 1280;
const NO_IMAGES = 'the current model does not accept images';

export const progress = (onUpdate, text) => onUpdate?.({ content: [{ type: 'text', text }] });
export const acceptsImages = model => !model || model.input.includes('image');
const downloading = onUpdate => () => progress(onUpdate, 'Downloading the video…');

/** The requested span in seconds, or undefined for the whole video. */
export function requestedSpan({ from, to }, duration) {
  if (from === undefined && to === undefined) return undefined;
  if (to === undefined && !duration) throw new Error('The length of this video is unknown: give both from and to.');
  const span = {
    from: from === undefined ? 0 : parseTimestamp(from),
    to: to === undefined ? duration : parseTimestamp(to),
  };
  if (!(span.to > span.from)) throw new Error('from must be before to.');
  if (duration && span.from >= duration) {
    throw new Error(`from is past the end of the video (${formatTimestamp(duration)}).`);
  }
  return duration ? { from: span.from, to: Math.min(span.to, duration) } : span;
}

async function captionsTranscript(library, entry, signal) {
  try {
    const cues = await library.captions(entry, signal);
    if (!cues?.length) return undefined;
    const kind = entry.track.automatic ? 'automatic subtitles' : 'platform subtitles';
    return { cues, kind, label: `${kind}, ${entry.track.language}` };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { failure: `Subtitles could not be downloaded: ${error.message}` };
  }
}

/** Whisper's cues for the video or span, or a note saying why there are none. */
async function whisperTranscript(job, model, signal) {
  const { library, entry, span, onUpdate } = job;
  const media = await library.media(entry, span, signal, downloading(onUpdate));
  const probed = await probe(media.input, signal);
  // A downloaded part is not the whole video: only a whole one tells the length.
  if (!entry.duration && !span) entry.duration = probed.duration;
  if (!probed.hasAudio) return { note: 'No transcript: the video has no audio track.' };
  const directory = await library.workspace('transcript');
  progress(onUpdate, 'Transcribing the audio with whisper…');
  const audio = join(directory, 'audio.wav');
  try {
    await extractAudio(media, span, audio, signal);
    const offset = span ? Math.max(span.from, media.offset) : media.offset;
    const cues = await transcribe({ audio, model, prefix: join(directory, 'transcript'), offset }, signal);
    return { cues, kind: 'whisper', label: 'whisper' };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { note: `No transcript: ${error.message}` };
  }
}

/** Platform subtitles first, then whisper when it is allowed for this request and configured. */
async function transcriptFor(job, { long, readConfig, signal }) {
  const captions = await captionsTranscript(job.library, job.entry, signal);
  if (captions?.cues) return { transcript: captions, notes: [] };
  const notes = captions?.failure ? [captions.failure] : [];
  const model = await readConfig('WHISPER_MODEL');
  if (long) {
    notes.push(
      model
        ? 'No subtitles: pass from and to to transcribe one part with whisper.'
        : 'No transcript: the video has no subtitles, and whisper needs WHISPER_MODEL to transcribe a part.',
    );
    return { notes };
  }
  if (!model) {
    notes.push(
      'No transcript: the video has no subtitles and no speech-to-text model is configured (set WHISPER_MODEL in ~/.config/pi-extensions/.env to a whisper.cpp model file).',
    );
    return { notes };
  }
  const spoken = await whisperTranscript(job, model, signal);
  if (spoken.note) return { notes: [...notes, spoken.note] };
  return { transcript: spoken, notes };
}

function frameJobs(library, media, { times, width }, signal) {
  return library.workspace('frames').then(directory =>
    times.map(async (time, index) => {
      const output = join(directory, `${index}.jpg`);
      await extractFrame(media, { time, width, output }, signal);
      return { time, output };
    }),
  );
}

/** Frames in order; frames that cannot be read become a note rather than losing the overview. */
async function overviewFrameSet(library, media, times, signal) {
  const settled = await Promise.allSettled(await frameJobs(library, media, { times, width: OVERVIEW_WIDTH }, signal));
  signal?.throwIfAborted();
  const failed = settled.filter(result => result.status === 'rejected');
  const frames = settled.filter(result => result.status === 'fulfilled').map(result => result.value);
  const notes = failed.length
    ? [`${failed.length} of ${times.length} frames could not be read: ${failed[0].reason?.message ?? failed[0].reason}`]
    : [];
  return { frames, notes };
}

async function overviewFrames(job, { long, signal }) {
  const { library, entry, span, onUpdate } = job;
  if (long) {
    progress(onUpdate, 'Reading frames from the stream…');
    const media = entry.kind === 'file' ? await library.media(entry) : await library.stream(entry, signal);
    return overviewFrameSet(library, media, overviewTimes({ from: 0, to: entry.duration, cuts: [] }), signal);
  }
  const media = await library.media(entry, span, signal, downloading(onUpdate));
  if (!entry.duration && !span) entry.duration = (await probe(media.input, signal)).duration;
  progress(onUpdate, 'Finding scene changes and extracting frames…');
  const bounds = span ?? { from: 0, to: entry.duration };
  const cuts = await sceneCuts(media, span, signal);
  return overviewFrameSet(library, media, overviewTimes({ ...bounds, cuts }), signal);
}

/**
 * Metadata, transcript and overview frames of a video or of one span of it.
 * @param {import('./library.js').VideoLibrary} library
 */
export async function describeVideo(library, params, { signal, onUpdate, model, cwd, readConfig }) {
  progress(onUpdate, 'Reading video information…');
  const entry = await library.entry(params.source, { cwd, signal });
  const span = requestedSpan(params, entry.duration);
  const long = !span && entry.duration > LONG_VIDEO_SECONDS;
  const job = { library, entry, span, onUpdate };
  const { transcript, notes } = await transcriptFor(job, { long, readConfig, signal });
  if (long) {
    notes.unshift(
      'This video is over 30 minutes: the overview uses subtitles and evenly spaced frames. Pass from and to to transcribe and scan one part in detail.',
    );
  }
  let extracted = [];
  if (acceptsImages(model)) {
    const result = await overviewFrames(job, { long, signal });
    extracted = result.frames;
    notes.push(...result.notes);
  } else notes.push(`Frames omitted: ${NO_IMAGES}.`);
  const text = transcript ? formatTranscript(transcript.cues, span) : '';
  return { entry, span, transcript: transcript && { ...transcript, text }, frames: extracted, notes };
}

/**
 * Frames at precise moments, in higher resolution: from the downloaded video, downloading a
 * short one first, or from the stream of a long one.
 * @param {import('./library.js').VideoLibrary} library
 */
export async function framesAt(library, params, { signal, onUpdate, model, cwd }) {
  if (!acceptsImages(model)) throw new Error(`Frames need a model that accepts images: ${NO_IMAGES}.`);
  const entry = await library.entry(params.source, { cwd, signal });
  const times = params.timestamps.map(parseTimestamp);
  const late = times.find(time => entry.duration && time > entry.duration);
  if (late !== undefined) {
    throw new Error(`${formatTimestamp(late)} is past the end of the video (${formatTimestamp(entry.duration)}).`);
  }
  const long = entry.duration > LONG_VIDEO_SECONDS;
  const media =
    (await library.downloaded(entry)) ??
    (long ? await library.stream(entry, signal) : await library.media(entry, undefined, signal, downloading(onUpdate)));
  progress(onUpdate, 'Extracting frames…');
  const jobs = await frameJobs(library, media, { times, width: DETAIL_WIDTH }, signal);
  return { entry, frames: await Promise.all(jobs) };
}
