import { wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { singleLineText } from '@clement_chsn/pi-shared/terminal-text';

const PAGE_BYTES = 8 * 1024;
const MAX_LINES = 600;
const MAX_BYTES = 64 * 1024;

function boundedUtf8(text, fromEnd) {
  const data = Buffer.from(text);
  if (data.length <= MAX_BYTES) return text;
  if (fromEnd) {
    let start = data.length - MAX_BYTES;
    while (start < data.length && (data[start] & 0xc0) === 0x80) start++;
    return data.subarray(start).toString('utf8');
  }
  let end = MAX_BYTES;
  while (end > 0 && (data[end] & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString('utf8');
}

/**
 * Bounded sliding window over one stream of a task log, scrolled by rows. Discarding displayed
 * text never discards the underlying log: byte offsets let either end be loaded again on demand.
 * While `following`, the window stays on the tail as output arrives.
 */
export class LogWindow {
  stream = 'stdout';
  /** @type {number | undefined} */
  start;
  /** @type {number | undefined} */
  end;
  text = '';
  error = '';
  scroll = 0;
  height = 16;
  width = 80;
  following = true;
  unavailableBefore = 0;
  /** @type {{ kind: 'page' | 'tail', version: number, home?: boolean, delta?: number } | undefined} */
  #loading;
  #version = 0;
  #source;

  /**
   * @param {{
   *   read: (offset: number | undefined, length: number | undefined, stream: string) => Promise<any>,
   *   totalBytes: (stream: string) => number,
   *   isOpen: () => boolean,
   *   changed: () => void,
   * }} source `read` without offset returns the tail; `changed` repaints the view.
   */
  constructor(source) {
    this.#source = source;
  }

  rows() {
    return this.text.split('\n').flatMap(line => wrapTextWithAnsi(singleLineText(line), Math.max(1, this.width - 2)));
  }

  /** The rows shown in a `width` × `height` viewport, scroll clamped to them. */
  viewport(width, height) {
    this.width = width;
    this.height = height;
    const rows = this.rows();
    const limit = Math.max(0, rows.length - height);
    this.scroll = this.following ? limit : Math.min(this.scroll, limit);
    return rows.slice(this.scroll, this.scroll + height);
  }

  /** Whether retention removed output before the displayed text. */
  get truncated() {
    return this.unavailableBefore > 0 && this.start <= this.unavailableBefore;
  }

  /** Initial read: the window opens on the tail. */
  async open() {
    this.#showTail(await this.#source.read(undefined, undefined, this.stream));
    this.scroll = Math.max(0, this.rows().length - this.height);
  }

  /** Loads the page before or after the window, unless a read is already pending. */
  async readPage(direction) {
    if (this.#loading || !this.#source.isOpen()) return;
    if (direction === 'older' && (this.start === undefined || this.start <= this.unavailableBefore)) return;
    const request = { kind: /** @type {const} */ ('page'), version: this.#version };
    this.#loading = request;
    try {
      const before = this.rows().length;
      const offset = direction === 'older' ? Math.max(this.unavailableBefore, this.start - PAGE_BYTES) : this.end;
      const length = direction === 'older' ? this.start - offset : PAGE_BYTES;
      const page = await this.#source.read(offset, length, this.stream);
      if (!this.#current(request)) return;
      this.unavailableBefore = page.unavailableBefore;
      this.error = page.logError ?? '';
      if (direction === 'older') this.#prepend(page, before);
      else this.#append(page);
    } catch (cause) {
      if (this.#current(request)) this.error = cause.message;
    } finally {
      if (this.#loading === request) this.#loading = undefined;
      this.#source.changed();
    }
  }

  /** Reloads the tail and follows it; navigation during the read is applied when it arrives. */
  jumpTail() {
    this.following = true;
    const request = { kind: /** @type {const} */ ('tail'), version: ++this.#version, home: false, delta: 0 };
    this.#loading = request;
    void this.#source
      .read(undefined, undefined, this.stream)
      .then(page => {
        if (!this.#current(request)) return;
        this.#showTail(page);
        const limit = Math.max(0, this.rows().length - this.height);
        this.scroll = this.following ? limit : Math.max(0, Math.min(limit, (request.home ? 0 : limit) + request.delta));
      })
      .catch(cause => {
        if (this.#current(request)) this.error = cause.message;
      })
      .finally(() => {
        // An obsolete read must not unlock a newer stream's pending read.
        if (this.#loading === request) this.#loading = undefined;
        this.#source.changed();
      });
  }

  switchStream() {
    this.stream = this.stream === 'stdout' ? 'stderr' : 'stdout';
    this.text = '';
    this.start = undefined;
    this.end = undefined;
    this.scroll = 0;
    this.error = '';
    this.unavailableBefore = 0;
    this.jumpTail();
    this.#source.changed();
  }

  home() {
    this.#pauseFollowing();
    if (this.#loading?.kind === 'tail') {
      this.#loading.home = true;
      this.#loading.delta = 0;
    }
    this.scroll = 0;
    this.#source.changed();
  }

  /** Scrolls by `delta` rows, loading the adjacent page at either edge of the window. */
  move(delta) {
    if (delta < 0 && this.following) this.#pauseFollowing();
    if (this.#loading?.kind === 'tail') {
      this.#loading.delta += delta;
    } else if (delta < 0) {
      this.following = false;
      if (this.scroll > 0) this.scroll = Math.max(0, this.scroll + delta);
      else void this.readPage('older');
    } else {
      const limit = Math.max(0, this.rows().length - this.height);
      const total = this.#source.totalBytes(this.stream);
      if (this.scroll < limit) this.scroll = Math.min(limit, this.scroll + delta);
      else if (this.end < total) void this.readPage('newer');
      else this.following = true;
      if (this.end >= total && this.scroll >= limit) this.following = true;
    }
    this.#source.changed();
  }

  #current(request) {
    return this.#source.isOpen() && request.version === this.#version;
  }

  #pauseFollowing() {
    this.following = false;
    // Keep an initializing tail alive; navigation is applied when it arrives.
    // Incremental reads may be discarded to preserve the current viewport.
    if (this.#loading?.kind !== 'tail') {
      this.#version++;
      this.#loading = undefined;
    }
  }

  #show(page) {
    this.start = page.start;
    this.end = page.nextOffset;
    this.text = page.text;
  }

  #showTail(page) {
    this.#show(page);
    this.unavailableBefore = page.unavailableBefore;
    this.error = page.logError ?? '';
    this.#bound('newer');
  }

  #prepend(page, rowsBefore) {
    if (page.start >= this.start) {
      this.#show(page);
      this.scroll = 0;
      return;
    }
    this.text = page.text + this.text;
    this.start = page.start;
    this.#bound('older');
    this.scroll = Math.max(0, this.scroll + this.rows().length - rowsBefore - 1);
  }

  #append(page) {
    if (this.end === undefined || page.start > this.end) {
      // Retention may have advanced while reading old output.
      this.#show(page);
      this.scroll = 0;
      return;
    }
    this.end = page.nextOffset;
    this.text += page.text;
    const unboundedRows = this.rows().length;
    this.#bound('newer');
    if (this.following) this.scroll = Math.max(0, this.rows().length - this.height);
    else if (page.text) this.scroll = Math.max(0, this.scroll - (unboundedRows - this.rows().length) + 1);
  }

  /** Keeps at most MAX_LINES lines and MAX_BYTES, dropping the side away from `direction`. */
  #bound(direction) {
    const parts = this.text.split('\n');
    if (parts.length <= MAX_LINES && Buffer.byteLength(this.text) <= MAX_BYTES) return;
    if (direction === 'older') {
      this.text = boundedUtf8(parts.slice(0, MAX_LINES).join('\n'), false);
      this.end = this.start + Buffer.byteLength(this.text);
    } else {
      this.text = boundedUtf8(parts.slice(-MAX_LINES).join('\n'), true);
      this.start = this.end - Buffer.byteLength(this.text);
    }
  }
}
