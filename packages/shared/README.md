# Pi shared

Code shared by the `@clement_chsn/pi-*` extensions, installed automatically as a dependency of
those that use it. It is not a Pi extension: it registers no tool, command or widget.

Modules are imported by subpath, for example `@clement_chsn/pi-shared/process-tree`:

- `activity-indicator`: the `pi.events` protocol between the activity bar and its producers;
- `bounded-text`: tool text cut to 600 lines and 24,000 bytes, with the complete text saved to a
  private file;
- `full-page`: a full-screen view over the conversation, without its images showing through;
- `process-tree`: reading `ps` and computing the cleanup targets of a process tree;
- `task-list`: a task list grouped by section, with selection by ID;
- `terminal-text`: untrusted text made safe for a terminal line;
- `tool-result`: a tool result whose text for the model and details carry the same JSON value;
- `user-config`: one value from the private `~/.config/pi-extensions/.env` file, such as an API key.

No stability guarantee outside these extensions: each depends on an exact version of this
package.
