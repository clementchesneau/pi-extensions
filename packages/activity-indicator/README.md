# Activity indicator

One line above the Pi editor for the
[Graphite](https://github.com/clementchesneau/pi-extensions/tree/main/packages/graphite-ui) run
timer and the number of running background tasks and subagents, instead of one widget each.

![Run timer on the left, task and subagent counters on the right](https://raw.githubusercontent.com/clementchesneau/pi-extensions/main/docs/images/graphite-running.png)

```sh
pi install npm:@clement_chsn/pi-activity-indicator
```

The timer sits on the left and the counters on the right; on a narrow terminal, the counters win.
It adds no tool or command. Without it, graphite-ui, subagents and background-tasks keep their own
widgets.

## For extension authors

The line speaks a small protocol over `pi.events`; constants and a producer client are in
`@clement_chsn/pi-shared/activity-indicator`.

| Event | Payload | Meaning |
| --- | --- | --- |
| `activity-indicator:ready` | `{ protocol: 1 }` | Emitted at each TUI session start: producers republish all their state |
| `activity-indicator:update` | `{ source, label, count }` | Replaces the counter of `source`; `count: 0` removes it |
| `activity-indicator:timer` | `{ text, active }` | Graphite's displayed duration, accented while `active`; `text: ''` hides it |

Call `connectActivityIndicator(pi)` at startup. On each render, publish through `update` and
`timer` when `available` is true, otherwise show your own widget; republish everything in
`onReady`. Ignore a `ready` of another protocol version, stop publishing once your session is
closed, and send `count: 0` when your extension is disabled.
