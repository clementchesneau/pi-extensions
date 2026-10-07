# Subagents

Lets the agent delegate missions to child Pi sessions that work in parallel while it keeps
going. Each child keeps its context, so the agent can send it follow-ups. `/subagents` shows
every mission live.

![/subagents list with one active and two finished missions](https://raw.githubusercontent.com/clementchesneau/pi-extensions/main/docs/images/subagents-list.png)

```sh
pi install npm:@clement_chsn/pi-subagents
```

Before you start:

- **Shared working directory.** Children edit the same files as the parent: no worktree, sandbox
  or rollback. Stopping a child does not undo its changes.
- **Extra cost.** Every mission makes its own model calls.
- **macOS or Linux.** On Linux, the `ps` from procps is required (`procps-ng` on Alpine; slim
  Docker images lack it). On Windows or without a compatible `ps`, missions are refused before
  anything starts.
- **Pi on Node.js**, installed with npm or Pi's installer. Compiled Bun and Node SEA builds are not
  supported.

## What the agent gets

| Tool | Purpose |
| --- | --- |
| `subagent_start` | Start a mission with its context; optionally a model, reasoning level or restricted tool list |
| `subagent_send` | Add instructions to a running mission, or continue a finished child |
| `subagent_result` | Read a run's response, page by page |
| `subagent_list` | List the children and their runs |
| `subagent_wait` | Wait for runs the agent is blocked on |
| `subagent_stop` | Stop one child |
| `subagent_models` | Browse your model catalogue for the models available in Pi |

A child starts with the parent's model, reasoning level and tools unless the mission says
otherwise. It gets the mission and the context the parent selects, not the parent's whole
history, and it cannot delegate in turn. Each child runs its own browser and language server
when it inherits ui-check or code-intelligence.

Results arrive as notifications marked **unverified**. The parent keeps working, then reads the
results its conclusions depend on. A child's answer is never treated as a user instruction.

## Following missions

`/subagents` opens a full-screen list of active and finished missions. Enter opens one, `s` stops
the selected active mission, Esc closes. The detail has three views:

| Key | View |
| --- | --- |
| `r` | **Response**: final answer of the latest run, as Markdown |
| `a` | **Activity**: the child's messages and tool calls across all runs, live |
| `i` | **Information**: mission, configuration, and every run with its instructions, duration, tokens and cost |

![Activity view of a finished mission](https://raw.githubusercontent.com/clementchesneau/pi-extensions/main/docs/images/subagents-detail.png)

←/→ switch views. ↑/↓, PgUp/PgDn, Home/End and the mouse wheel scroll; `Ctrl+O` expands tool
output. A view follows new output while you are at its bottom.

Outside the TUI, `/subagents` prints a text summary. The tools work in every Pi mode (TUI, RPC,
print and JSON).

## Settings

In the TUI, `/subagents settings` edits two settings, stored in
`~/.config/pi-extensions/subagents.json` and shared by all projects; outside the TUI, it only shows
them:

- **Automatic delegation** (`autoDelegate`, on by default). When off, every launch asks for your
  confirmation; without a UI to confirm, launches are refused.
- **Maximum concurrency** (`maxConcurrent`, 4 by default). Starting, active and stopping runs
  count; requests over the limit are refused, not queued.

## Choosing models

`subagent_models` reads `~/.config/pi-extensions/subagent-models.json`, created on first use from
the catalogue shipped with the package. Each entry tells the agent what a model suits:

```json
{
  "provider": "openai-codex",
  "id": "gpt-6-luna",
  "preferFor": "Focused, repetitive, high-volume tasks.",
  "avoidFor": "End-to-end work requiring deep reasoning.",
  "effort": { "simple": "low", "standard": "medium", "complex": "high" },
  "tradeoff": "Described by OpenAI as the most cost-efficient GPT-6 variant; deeper reasoning increases token usage.",
  "sources": ["https://developers.openai.com/api/docs/models/gpt-6-luna"],
  "reviewedOn": "2026-09-27"
}
```

Only models available in your Pi are offered; prices come from Pi, not from this file. The file
follows package updates until you edit it. From then on it is yours, and `subagent_models`
mentions when the shipped catalogue changes; delete the file to get the shipped version back.

## Data and cleanup

- Results and transcripts are stored privately under `<agentDir>/subagents/<session>/` and remain
  readable when you resume the session. They may contain sensitive data: delete them when you no
  longer need them.
- Closing Pi, reloading or switching session stops active missions. They show as interrupted, and
  the agent can continue them later from their saved transcript.
- `/tree` stops only the missions started on the branch you leave; those started earlier in the
  history you return to keep running and editing files. A mission of an abandoned branch cannot be
  continued from another branch.
- If stopping a child fails, the extension reports it and tries again; it never shows a running
  child as stopped.

## After updating Pi

Restart Pi before starting or continuing a child. An open session keeps the old Pi code in memory,
and children must run the same Pi as their parent: the extension refuses to start them until you
restart.

## Embedding in an SDK host

In a native SDK integration without the Pi CLI, pass the host SDK explicitly with
`subagents(pi, { sdk })` if the extension's dependency tree differs from the parent's. Without
injection, initialization is asynchronous: direct callers must `await subagents(pi, options)`.
