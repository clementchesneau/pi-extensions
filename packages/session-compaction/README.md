# Session compaction

Lets the agent compact its context at a good moment, once usage reaches 60% and a step is done,
rather than when Pi's automatic threshold hits mid-task. Before compacting, it writes short notes;
afterwards, it sees their index and rereads only what it needs.

```sh
pi install npm:@clement_chsn/pi-session-compaction
```

It works with any provider and makes no model call of its own: the compaction uses Pi's usual
summary, and Pi's compaction settings are left unchanged. With
[graphite-ui](https://github.com/clementchesneau/pi-extensions/tree/main/packages/graphite-ui),
the footer's context percentage turns blue once compaction is available.

## What the agent gets

| Tool | Purpose |
| --- | --- |
| `session_compaction_status` | Context usage, whether voluntary compaction is available, Pi's automatic threshold, notes index |
| `session_memory_write` | Create or update a note (up to 32 notes of 32 KiB) |
| `session_memory_read` | Read a note, page by page |
| `session_memory_delete` | Remove a note from the current branch |
| `session_compact` | Ask Pi to compact now; available from 60% usage |

Each model request also carries a short note with the remaining budget and, after a compaction,
the notes index (never their content). The agent is guided to keep approved constraints,
verified evidence, decisions, open questions and next steps, and no secrets or raw logs.

## Where notes live

- In a private folder of the system temporary directory, outside your repository.
- They follow the session tree: `/tree` restores the notes of the selected branch, and `/fork`
  copies them. `/reload` keeps them.
- They are deleted when the session closes or is replaced; resuming it later does not bring them
  back. After a crash, the next start cleans the leftovers it can prove are orphaned.
- **Pi still records tool arguments and results**: note contents also remain in the session file
  and exports.

## Limits

- `session_compact` is refused in Pi's print and JSON modes, which exit before a compaction can
  complete. Pi's automatic compaction still works there.
- A custom SDK host must keep the runtime alive until a requested compaction completes and the
  agent resumes.

## For extension authors

The extension emits `session-compaction:state` on `pi.events`:

```js
{ percent: number | null, lowPercent: 60, highPercent: number | null,
  phase: 'below' | 'available' | 'automatic' | 'compacting' | 'unknown',
  enabled: boolean | null }
```

`enabled` is Pi's automatic compaction setting; `null` means the settings could not be read. Emit
`session-compaction:request-state` to get the current state.
