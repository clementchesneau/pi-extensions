import { constants } from 'node:fs';
import { lstat, mkdtemp, chmod, open, rename, realpath, readdir, unlink, rmdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { readPrivateJson } from './private-file.js';

export { collectOrphans } from './orphans.js';

export const MAX_CONTENT_BYTES = 32768;
export const MAX_NOTES = 32;
const REVISION = /^[a-f0-9]{32}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const uid = () => process.getuid?.();
const within = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

export function validateNote({ id, title, content }) {
  if (typeof id !== 'string' || !ID.test(id))
    throw new Error('Memory id must be 1–64 lowercase letters, digits, hyphens or underscores');
  if (typeof title !== 'string' || !title.trim() || title.length > 80 || /[\r\n\x00-\x1f\x7f]/.test(title))
    throw new Error('Memory title must be a single line of 1–80 characters');
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > MAX_CONTENT_BYTES)
    throw new Error(`Memory content must be nonempty and at most ${MAX_CONTENT_BYTES} UTF-8 bytes`);
}

/** Immutable blobs; branch snapshots hold only references, never the memory contents. */
export class MemoryStore {
  static async create({ parent = tmpdir(), cwd = process.cwd() } = {}) {
    parent = await realpath(parent);
    if (within(await realpath(cwd), parent))
      throw new Error('Memory temporary directory must be outside the workspace');
    const directory = await mkdtemp(join(parent, `pi-session-compaction-${process.pid}-`));
    await chmod(directory, 0o700);
    const store = new MemoryStore(directory, await lstat(directory));
    const marker = await open(
      join(directory, 'owner.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    store.files.add('owner.json');
    try {
      await marker.writeFile(
        JSON.stringify({
          kind: 'pi-session-compaction',
          version: 1,
          pid: process.pid,
          uid: uid() ?? null,
          storeId: store.id,
        }),
      );
      await marker.sync();
    } finally {
      await marker.close();
    }
    return store;
  }

  constructor(directory, identity) {
    this.directory = directory;
    this.identity = identity;
    this.id = randomBytes(16).toString('hex');
    this.files = new Set();
    this.closed = false;
  }

  async assertRoot() {
    if (this.closed) throw new Error('Memory store is closed');
    const stat = await lstat(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== this.identity.dev ||
      stat.ino !== this.identity.ino ||
      (uid() !== undefined && stat.uid !== uid()) ||
      (stat.mode & 0o777) !== 0o700 ||
      (await realpath(this.directory)) !== this.directory
    ) {
      throw new Error('Unsafe memory store directory');
    }
  }

  async write(note) {
    validateNote(note);
    await this.assertRoot();
    const revision = randomBytes(16).toString('hex');
    const filename = `${revision}.json`;
    const temporary = `${revision}.tmp`;
    const handle = await open(
      join(this.directory, temporary),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    this.files.add(temporary);
    try {
      await handle.writeFile(
        JSON.stringify({ id: note.id, title: note.title, content: note.content, revision }),
        'utf8',
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.assertRoot();
    await rename(join(this.directory, temporary), join(this.directory, filename));
    this.files.delete(temporary);
    this.files.add(filename);
    return { id: note.id, title: note.title, revision, bytes: Buffer.byteLength(note.content) };
  }

  async read(reference) {
    if (!reference || !REVISION.test(reference.revision)) throw new Error('Invalid memory revision');
    await this.assertRoot();
    const filename = `${reference.revision}.json`;
    if (!this.files.has(filename)) throw new Error('Memory revision unavailable in this active session');
    const { value: note } = await readPrivateJson(join(this.directory, filename), {
      maxBytes: MAX_CONTENT_BYTES * 7,
      label: 'memory file',
    });
    validateNote(note);
    if (
      note.revision !== reference.revision ||
      note.id !== reference.id ||
      note.title !== reference.title ||
      Buffer.byteLength(note.content) !== reference.bytes
    )
      throw new Error('Memory reference does not match file');
    return note;
  }

  /** Identities of `files`; throws unless each is a private regular file this store wrote. */
  async #ownedFileIdentities(files) {
    const identities = new Map();
    for (const filename of files) {
      if (!this.files.has(filename)) throw new Error('Memory cleanup refused: unowned file');
      const stat = await lstat(join(this.directory, filename));
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        (uid() !== undefined && stat.uid !== uid())
      )
        throw new Error('Memory cleanup refused: unsafe file');
      identities.set(filename, stat);
    }
    return identities;
  }

  async close() {
    if (this.closed) return;
    await this.assertRoot();
    // Preflight everything before deleting anything. Never recursively remove a
    // directory or follow a link; preserve the owner marker until the last unlink.
    const files = await readdir(this.directory);
    const identities = await this.#ownedFileIdentities(files);
    for (const filename of files.filter(file => file !== 'owner.json').concat('owner.json')) {
      await this.assertRoot();
      const path = join(this.directory, filename);
      const stat = await lstat(path);
      const identity = identities.get(filename);
      if (!identity || !stat.isFile() || stat.nlink !== 1 || stat.dev !== identity.dev || stat.ino !== identity.ino)
        throw new Error('Memory cleanup refused: file changed');
      await unlink(path);
      this.files.delete(filename);
    }
    await this.assertRoot();
    await rmdir(this.directory);
    this.closed = true;
  }
}
