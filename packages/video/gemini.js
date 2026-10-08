import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { encodeClip } from './media.js';
import { progress, requestedSpan } from './overview.js';

const API = 'https://generativelanguage.googleapis.com';
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const PROCESSING_LIMIT_MS = 5 * 60_000;
const DELETE_LIMIT_MS = 15_000;

/**
 * @typedef {{ fetch: typeof fetch, apiKey: string, signal?: AbortSignal }} Client
 * @typedef {{ name: string, uri: string, mimeType: string, state: string }} GeminiFile
 */

/** Sends one request with the key in a header, and turns an error answer into its message only. */
async function call(client, url, init = {}, signal = client.signal) {
  const response = await client.fetch(url, {
    ...init,
    signal,
    headers: { 'x-goog-api-key': client.apiKey, ...init.headers },
  });
  if (response.ok) return response;
  const message = await response
    .json()
    .then(body => body?.error?.message)
    .catch(() => undefined);
  throw new Error(`Gemini request failed (HTTP ${response.status})${message ? `: ${message}` : ''}.`);
}

/**
 * Resumable upload through the Files API, streamed from disk, under a name unique to this upload.
 * @returns {Promise<GeminiFile>}
 */
async function upload(client, { path, size, displayName }) {
  const start = await call(client, `${API}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': 'video/mp4',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  const session = start.headers.get('x-goog-upload-url');
  if (!session) throw new Error('Gemini did not return an upload address.');
  const done = await call(client, session, {
    method: 'POST',
    headers: {
      'Content-Length': String(size),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: /** @type {ReadableStream} */ (Readable.toWeb(createReadStream(path))),
    duplex: 'half',
  });
  return (await done.json()).file;
}

/** Waits until Gemini has processed the uploaded video; the time limit also stops a hanging request. */
async function active(client, file, { pollMs, timeoutMs }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([deadline, ...(client.signal ? [client.signal] : [])]);
  try {
    let current = file;
    while (current.state === 'PROCESSING') {
      await sleep(pollMs, undefined, { signal });
      current = await (await call(client, `${API}/v1beta/${file.name}`, {}, signal)).json();
    }
    if (current.state !== 'ACTIVE') throw new Error(`Gemini could not process the video (state ${current.state}).`);
    return current;
  } catch (error) {
    if (deadline.aborted && !client.signal?.aborted) {
      throw new Error('Gemini took too long to process the video.', { cause: error });
    }
    throw error;
  }
}

/** Deletes an upload with its own deadline, since the tool's signal may be cancelled; returns the failure. */
async function remove(client, name) {
  const signal = AbortSignal.timeout(DELETE_LIMIT_MS);
  return call(client, `${API}/v1beta/${name}`, { method: 'DELETE' }, signal).then(
    () => undefined,
    error => error,
  );
}

/**
 * Deletes the upload with this display name, for an upload whose answer was lost: the file may
 * exist on Google's side without this extension knowing its name. Searches every page of the
 * list; returns the failure, if any.
 */
async function removeByDisplayName(client, displayName) {
  const signal = AbortSignal.timeout(DELETE_LIMIT_MS);
  try {
    let pageToken;
    do {
      const query = new URLSearchParams({ pageSize: '100', ...(pageToken ? { pageToken } : {}) });
      const listed = await (await call(client, `${API}/v1beta/files?${query}`, {}, signal)).json();
      const file = (listed.files ?? []).find(candidate => candidate.displayName === displayName);
      if (file) return await remove(client, file.name);
      pageToken = listed.nextPageToken;
    } while (pageToken);
    return undefined;
  } catch (error) {
    return error;
  }
}

const deletionWarning = error =>
  `Warning: the uploaded video could not be deleted from Gemini (${error.message}); Gemini deletes uploads after 48 hours.`;

/** The failure, with the deletion problem in its message; a cancellation stays a cancellation. */
function withDeletionWarning(failure, undeleted) {
  if (!undeleted) return failure;
  const message = `${failure?.message ?? failure} ${deletionWarning(undeleted)}`;
  if (failure?.name === 'AbortError') return new DOMException(message, 'AbortError');
  return new Error(message, { cause: failure });
}

async function generate(client, model, parts) {
  const response = await call(client, `${API}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }] }),
  });
  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map(part => part.text ?? '')
    .join('')
    .trim();
  if (text) return text;
  const blocked = data.promptFeedback?.blockReason;
  throw new Error(`Gemini returned no answer${blocked ? ` (blocked: ${blocked})` : ''}.`);
}

/**
 * The file to send, re-encoded as a small MP4 without metadata and cut exactly to the span: only
 * that part of the video leaves the machine, whatever its codec.
 */
async function videoFile(library, { entry, span, signal, onUpdate }) {
  const media = await library.media(entry, span, signal, () => progress(onUpdate, 'Downloading the video…'));
  // A whole video over the limit is refused before spending time rewriting it.
  if (!span) assertUploadable((await stat(media.input)).size, span);
  progress(onUpdate, 'Preparing the video…');
  const output = join(await library.workspace('clip'), 'clip.mp4');
  await encodeClip(media, span, output, signal);
  return output;
}

function assertUploadable(size, span) {
  if (size <= MAX_UPLOAD_BYTES) return;
  const megabytes = Math.ceil(size / 1024 / 1024);
  const advice = span ? 'pass a shorter from/to range' : 'pass from and to to send one part';
  throw new Error(`The video to send is ${megabytes} MB, over the 200 MB limit for Gemini: ${advice}.`);
}

async function uploadedAnswer(client, job) {
  const { library, entry, span, model, question, polling, onUpdate } = job;
  const path = await videoFile(library, { entry, span, signal: client.signal, onUpdate });
  const { size } = await stat(path);
  assertUploadable(size, span);
  progress(onUpdate, 'Uploading the video to Gemini…');
  const displayName = `pi-video-${randomUUID()}`;
  let file;
  try {
    file = await upload(client, { path, size, displayName });
  } catch (error) {
    throw withDeletionWarning(error, await removeByDisplayName(client, displayName));
  }
  let answer;
  let failure;
  try {
    progress(onUpdate, 'Waiting for Gemini to process the video…');
    const ready = await active(client, file, polling);
    progress(onUpdate, 'Asking Gemini…');
    answer = await generate(client, model, [
      { fileData: { fileUri: ready.uri, mimeType: ready.mimeType } },
      { text: question },
    ]);
  } catch (error) {
    failure = error;
  }
  // Do not keep the video on Google's side longer than the question needs, even after Esc.
  const undeleted = await remove(client, file.name);
  if (failure) throw withDeletionWarning(failure, undeleted);
  return { answer, warning: undeleted && deletionWarning(undeleted) };
}

/**
 * Gemini's answer to a question about a video: a YouTube URL is read by Gemini directly, any
 * other video is uploaded, then deleted.
 * @param {import('./library.js').VideoLibrary} library
 */
export async function askGemini(library, params, { signal, onUpdate, cwd, readConfig, gemini }) {
  const apiKey = await readConfig('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured in the environment or ~/.config/pi-extensions/.env.');
  const model = (await readConfig('GEMINI_VIDEO_MODEL')) || DEFAULT_MODEL;
  const client = { fetch: gemini.fetch ?? fetch, apiKey, signal };
  const entry = await library.entry(params.source, { cwd, signal });
  const span = requestedSpan(params, entry.duration);
  if (entry.isYouTube) {
    const clip = span ? { videoMetadata: { startOffset: `${span.from}s`, endOffset: `${span.to}s` } } : {};
    const parts = [{ fileData: { fileUri: entry.source }, ...clip }, { text: params.question }];
    progress(onUpdate, 'Asking Gemini…');
    return { entry, span, model, uploaded: false, answer: await generate(client, model, parts) };
  }
  const polling = { pollMs: gemini.pollMs ?? 2000, timeoutMs: gemini.processingTimeoutMs ?? PROCESSING_LIMIT_MS };
  const job = { library, entry, span, model, question: params.question, polling, onUpdate };
  const { answer, warning } = await uploadedAnswer(client, job);
  return { entry, span, model, uploaded: true, answer, warning };
}
