# Code intelligence

TypeScript and JavaScript navigation for the agent through a local language server. One tool,
`code_nav`, with five actions: `symbols`, `definition`, `references`, `hover` and `diagnostics`.

```sh
pi install npm:@clement_chsn/pi-code-intelligence
```

Nothing to configure or add to your projects: the package ships `typescript-language-server` and
`typescript`. A project's own versions are used when it has them.

## Usage

The agent calls `code_nav` when it needs it. `line` and `column` start at 1.

```json
{ "action": "symbols", "path": "src/index.ts" }
{ "action": "symbols", "path": "src/index.ts", "query": "createClient" }
{ "action": "definition", "path": "src/index.ts", "line": 18, "column": 12 }
{ "action": "references", "path": "src/index.ts", "line": 18, "column": 12, "limit": 100 }
{ "action": "hover", "path": "src/index.ts", "line": 18, "column": 12 }
{ "action": "diagnostics", "path": "src/index.ts" }
```

`symbols` lists a file's symbols, or searches the workspace when given a `query`. `diagnostics`
returns fresh errors for the file as saved on disk.

## How it behaves

- Supports `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs`. The project root is
  the nearest folder with a `tsconfig.json`, `jsconfig.json` or `package.json`, without going
  above Pi's working directory.
- Server resolution prefers the project's `node_modules/.bin/typescript-language-server`, then
  the bundled one, then `PATH`. The server prefers the project's TypeScript, then the bundled one.
- The server starts on the first call for a project and stops after five minutes of inactivity,
  on session shutdown or reload. Esc cancels the current request.
- Every call rereads the files from disk: unsaved editor buffers are not seen.
- Diagnostics are pushed by the server without an end-of-analysis signal, so the result says it
  may be incomplete.
- Results are capped at 50 items by default (200 at most), 2,000 lines and 50 KB; a truncated
  result points to a private temporary file with the full output.

## Troubleshooting

| Error | Meaning |
| --- | --- |
| `typescript-language-server was not found` | The package installation is incomplete: reinstall it, or install `typescript` and `typescript-language-server` in the project |
| `not supported` | The server does not offer this action |
| `timed out` | No response within the time limit; check the server's health |
| `exited unexpectedly`, `connection closed` | The server crashed; the error includes its recent stderr and the next call starts a new one |
