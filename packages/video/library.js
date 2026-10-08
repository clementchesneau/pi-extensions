import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedUrl, publicAddresses } from '@clement_chsn/pi-shared/public-url';
import { probe } from './media.js';
import { parseCaptions } from './transcript.js';
import { captionTrack, downloadCaptions, downloadVideo, readInfo, streamUrl } from './ytdlp.js';

const PREFIX = 'pi-video-';
const OWNER = 'owner';
// Sites make stream addresses expire, YouTube after about six hours.
const STREAM_LIFETIME_MS = 60 * 60_000;
// Formats ffprobe reads as video although they are pictures or text.
const NOT_VIDEO = /(?:^|,)(?:tty|image2|[a-z0-9]+_pipe)(?:,|$)/;

/**
 * @typedef {{
 *   kind: 'file' | 'url', key: string, source: string, title: string, duration: number,
 *   path?: string, url?: string, uploader?: string, description?: string,
 *   chapters: { start: number, title: string }[], track?: { language: string, automatic: boolean },
 *   isYouTube: boolean,
 * }} VideoEntry
 */

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
};

/** Only a directory this extension created, owned by this user, whose session process is gone. */
async function isOrphan(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) return false;
  const owner = Number(await readFile(join(directory, OWNER), 'utf8').catch(() => ''));
  return owner > 0 && !alive(owner);
}

/** A local path as Pi's own tools read it: relative to the working directory, ~ and a leading @ allowed. */
function localPath(source, cwd) {
  if (source.startsWith('file:')) return fileURLToPath(source);
  const path = source.replace(/^@/, '');
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1));
  return resolvePath(cwd ?? process.cwd(), path);
}

async function fileEntry(path, signal) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`No video file at ${path}.`);
  const probed = await probe(path, signal);
  if (!probed.hasVideo) throw new Error(`${path} has no video stream.`);
  if (!(probed.duration > 0) || NOT_VIDEO.test(probed.formatName)) throw new Error(`${path} is not a video file.`);
  return {
    kind: 'file',
    key: path,
    path,
    source: path,
    title: basename(path),
    duration: probed.duration,
    chapters: [],
    isYouTube: false,
  };
}

function urlEntry(url, info) {
  return {
    kind: 'url',
    key: url,
    url,
    source: info.webpage_url || url,
    title: info.title || url,
    uploader: info.uploader || info.channel || undefined,
    duration: Number(info.duration) || 0,
    description: info.description || undefined,
    chapters: (info.chapters ?? []).map(chapter => ({ start: Number(chapter.start_time), title: chapter.title })),
    track: captionTrack(info),
    isYouTube: info.extractor_key === 'Youtube',
  };
}

/**
 * The videos of one session: what was learned about each source and the files downloaded for
 * it, in a private directory removed at shutdown.
 */
export class VideoLibrary {
  #directory;
  #cache = new Map();
  #streams = new Map();
  #count = 0;

  /**
   * @param {{ tmp?: string, resolve?: typeof import('node:dns/promises').lookup, now?: () => number }} [options]
   */
  constructor({ tmp = tmpdir(), resolve, now = Date.now } = {}) {
    this.tmp = tmp;
    this.resolve = resolve;
    this.now = now;
  }

  /** Removes the directories of this user's sessions whose process is gone; never fails. */
  static async sweepOrphans(tmp = tmpdir()) {
    const names = await readdir(tmp).catch(() => []);
    for (const name of names.filter(entry => entry.startsWith(PREFIX))) {
      const directory = join(tmp, name);
      try {
        if (await isOrphan(directory)) await rm(directory, { recursive: true, force: true });
      } catch {
        /* Kept for a later sweep; one directory must not stop the others. */
      }
    }
  }

  directory() {
    this.#directory ??= mkdtemp(join(this.tmp, PREFIX)).then(async directory => {
      await writeFile(join(directory, OWNER), String(process.pid), { mode: 0o600 });
      return directory;
    });
    const pending = this.#directory;
    // A failed creation is retried by the next call rather than remembered.
    pending.catch(() => {
      if (this.#directory === pending) this.#directory = undefined;
    });
    return pending;
  }

  /** A new private subdirectory for one job. */
  async workspace(name) {
    const directory = join(await this.directory(), `${++this.#count}-${name}`);
    await mkdir(directory, { mode: 0o700 });
    return directory;
  }

  async close() {
    const pending = this.#directory;
    this.#directory = undefined;
    this.#cache.clear();
    this.#streams.clear();
    const directory = await pending?.catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  /** Runs `load` once per key; a failure is not kept, so a later call retries. */
  #once(key, load) {
    if (!this.#cache.has(key)) {
      const pending = load();
      this.#cache.set(key, pending);
      pending.catch(() => this.#cache.delete(key));
    }
    return this.#cache.get(key);
  }

  /**
   * @param {string} source a URL or a path, relative to `cwd`
   * @param {{ cwd?: string, signal?: AbortSignal }} [options]
   * @returns {Promise<VideoEntry>}
   */
  entry(source, { cwd, signal } = {}) {
    if (!/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('file:')) {
      const path = localPath(source, cwd);
      return this.#once(`file:${path}`, () => fileEntry(path, signal));
    }
    const url = checkedUrl(source).href;
    return this.#once(`url:${url}`, async () => {
      await publicAddresses(new URL(url), { resolve: this.resolve, signal });
      return urlEntry(url, await readInfo(url, signal));
    });
  }

  /**
   * A local copy of the video, or of the span only, with the video time it starts at.
   * `onDownload` is called when a download actually starts.
   * @returns {Promise<import('./media.js').Media>}
   */
  media(entry, span, signal, onDownload) {
    if (entry.kind === 'file') return Promise.resolve({ input: entry.path, offset: 0 });
    const key = `media:${entry.key}:${span ? `${span.from}-${span.to}` : 'all'}`;
    return this.#once(key, async () => {
      onDownload?.();
      const path = await downloadVideo(entry.url, await this.workspace('video'), span, signal);
      return { input: path, offset: span?.from ?? 0 };
    });
  }

  /** The whole video already downloaded in this session, if any. */
  downloaded(entry) {
    return entry.kind === 'file' ? this.media(entry) : this.#cache.get(`media:${entry.key}:all`);
  }

  /** A stream of the video read in place, for frames of a long video that is not downloaded. */
  stream(entry, signal) {
    const cached = this.#streams.get(entry.key);
    if (cached && this.now() - cached.at < STREAM_LIFETIME_MS) return cached.pending;
    const pending = (async () => {
      const url = await streamUrl(entry.url, signal);
      await publicAddresses(checkedUrl(url), { resolve: this.resolve, signal });
      return { input: url, offset: 0 };
    })();
    this.#streams.set(entry.key, { pending, at: this.now() });
    pending.catch(() => this.#streams.delete(entry.key));
    return pending;
  }

  /** Cues of the chosen caption track, or undefined when there is none. */
  captions(entry, signal) {
    if (!entry.track) return Promise.resolve(undefined);
    return this.#once(`captions:${entry.key}`, async () => {
      const text = await downloadCaptions(entry.url, entry.track, await this.workspace('captions'), signal);
      return text ? parseCaptions(text) : undefined;
    });
  }
}
