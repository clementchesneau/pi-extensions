# Graphite UI

A dark look for the Pi terminal: the Graphite theme, a compact header, run timers, and a
two-line footer with context, cost and Git status.

![Graphite header, run durations, total and footer](https://raw.githubusercontent.com/clementchesneau/pi-extensions/main/docs/images/graphite.png)

```sh
pi install npm:@clement_chsn/pi-graphite-ui
```

It applies automatically in the TUI and looks best in a truecolor terminal.

## What it shows

- **Header**: the Pi logo and the current directory, compact when the terminal is narrow.
- **Run timer**: above the editor, the duration of the current run, the total of the branch from
  the second run, and the number of compactions (`comp`). Each finished run leaves its duration
  and end time in the conversation (`⏱ 1m 42s · run duration · 14:08:08`), without sending it to
  the model.
- **Footer**: path, model and thinking level; context use (`42%/200k`), cost and tokens; Git
  branch and number of changed files. On a narrow terminal, context and cost win. Statuses from
  other extensions stay below.
- **Working indicator**: an animated braille spinner.

With [session-compaction](https://github.com/clementchesneau/pi-extensions/tree/main/packages/session-compaction),
the context percentage turns blue once compaction is available and yellow past Pi's automatic
threshold. With [activity-indicator](https://github.com/clementchesneau/pi-extensions/tree/main/packages/activity-indicator),
the timer shares its line with the counts of background tasks and subagents.

## Command

`/graphite-ui` toggles the custom header, footer and working indicator for the session
(`/graphite-ui on` and `off` also work); the theme stays. `/graphite-ui refresh` rereads the Git
status.

## Good to know

- Pi's native Context, Skills and Extensions sections need `"quietStartup": false` in
  `~/.pi/agent/settings.json`. Pi may then briefly show its own header before Graphite's;
  `quietStartup: true` removes the flash but hides those sections.
- Git status is read locally, without a shell, network or polling, after your inputs, tool calls
  and agent runs. A change made from another terminal while Pi is idle shows at the next of these,
  or with `/graphite-ui refresh`.
- When the repository's own Git config sets a command that `git status` would run, an fsmonitor
  hook or a content filter such as a local Git LFS install, the footer shows the branch only, so
  that opening Pi in a downloaded repository runs nothing from it. Changes inside submodules are
  not counted, and a partial clone never fetches a missing object for the footer, which then shows
  `git ?` (Git 2.45 or later), for the same reason. Before Git 2.26, the footer always shows the
  branch only; before Git 2.36, also when the repository sets `core.fsmonitor` to `true` or
  `false`, which those versions run as a hook.
- Tokens and cost add up the assistant messages of the active branch; they are not an invoice.
- The timer total survives compactions, reloads, resumes and forks, and follows the branch you
  select with `/tree`.
- An extension that installs its own footer replaces Graphite's: Pi shows one custom footer.
