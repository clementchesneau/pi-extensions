import { dirname, join } from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { collectOrphans, MAX_NOTES, MemoryStore } from './store.js';

const SNAPSHOT = 'session-compaction:memory-v1';
const REGISTRY = Symbol.for('pi-extensions.session-compaction.stores.v1');
const keyFor = ctx => JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile()]);

/**
 * Stores by session, shared by every load of this extension in the process: a `/reload`
 * re-runs the extension and must find the notes of the session it continues.
 */
export const processRegistry = () => (globalThis[REGISTRY] ??= new Map());

function branchSnapshot(ctx) {
  return ctx.sessionManager
    .getBranch()
    .filter(entry => entry.type === 'custom' && entry.customType === SNAPSHOT)
    .at(-1)?.data;
}

async function closeHandoffs(registry) {
  for (const session of [...registry.values()].filter(value => value.handoff)) {
    await session.store.close();
    registry.delete(session.key);
  }
}

/**
 * Branch-local curated memory of the active session. Branch snapshots hold references only;
 * contents live in a private store outside the workspace. A fork hands its store over to
 * the new session, which copies the notes of its branch before the old store is closed.
 */
export function createMemory(pi, { tempParent, registry }) {
  let active;

  function reconstruct(ctx) {
    const saved = branchSnapshot(ctx);
    const valid = saved?.version === 1 && Array.isArray(saved.notes);
    active.notes = valid && saved.storeId === active.store.id ? saved.notes.slice(0, MAX_NOTES) : [];
    active.unavailableNotes = valid && saved.storeId !== active.store.id ? saved.notes.length : 0;
  }

  function current() {
    if (!active) throw new Error('No active memory session');
    return active;
  }

  function snapshot() {
    const session = current();
    pi.appendEntry(SNAPSHOT, { version: 1, storeId: session.store.id, notes: session.notes });
  }

  async function adoptForkNotes(ctx, store) {
    const saved = branchSnapshot(ctx);
    const source = [...registry.values()].find(session => session.handoff && session.store.id === saved?.storeId);
    try {
      if (!source || saved?.version !== 1 || !Array.isArray(saved.notes)) return;
      for (const reference of saved.notes.slice(0, MAX_NOTES)) {
        const { id, title, content } = await source.store.read(reference);
        active.notes.push(await store.write({ id, title, content }));
      }
      active.unavailableNotes = 0;
      snapshot();
    } finally {
      await closeHandoffs(registry);
    }
  }

  return {
    get active() {
      return active;
    },
    current,
    snapshot,

    /** Runs `fn` on the session alone, unless the session or its branch changed meanwhile. */
    mutate(fn) {
      const session = current();
      const generation = session.generation;
      return withFileMutationQueue(join(session.store.directory, 'branch-index'), async () => {
        if (active !== session || session.generation !== generation)
          throw new Error('Memory session or branch changed');
        return fn(session);
      });
    },

    async start(event, ctx) {
      const key = keyFor(ctx);
      const store = registry.get(key)?.store ?? (await MemoryStore.create({ parent: tempParent, cwd: ctx.cwd }));
      await collectOrphans({ parent: dirname(store.directory) });
      active = { key, store, notes: [], unavailableNotes: 0, generation: 0 };
      registry.set(key, active);
      reconstruct(ctx);
      if (event.reason === 'fork') await adoptForkNotes(ctx, store);
    },

    changeBranch(ctx) {
      if (!active) return;
      active.generation++;
      reconstruct(ctx);
    },

    async shutdown(event) {
      const session = active;
      active = undefined;
      if (!session || event.reason === 'reload') return;
      if (event.reason === 'fork') {
        session.handoff = true;
        return;
      }
      await session.store.close();
      registry.delete(session.key);
      // Also release a fork handoff if startup of its replacement never completed.
      if (event.reason === 'quit') await closeHandoffs(registry);
    },
  };
}
