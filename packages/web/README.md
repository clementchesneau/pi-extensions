# Web

Web tools for the agent, independent of your AI provider: Brave search, page reading as
Markdown, and versioned library documentation from Context7.

```sh
pi install npm:@clement_chsn/pi-web
```

| Tool | Purpose | Key |
| --- | --- | --- |
| `web_search` | Search the web with Brave: titles, URLs, snippets | `BRAVE_API_KEY` |
| `web_fetch` | Read a public page as Markdown (HTML, text, Markdown, JSON) | None |
| `context7_resolve` | Find a library's Context7 ID and its indexed versions | `CONTEXT7_API_KEY` |
| `context7_docs` | Read documentation excerpts with their sources | `CONTEXT7_API_KEY` |

## API keys

Put your keys in `~/.config/pi-extensions/.env`, a private file outside any repository:

```sh
mkdir -p ~/.config/pi-extensions
touch ~/.config/pi-extensions/.env && chmod 600 ~/.config/pi-extensions/.env
```

Then add the keys with an editor, so they stay out of your shell history:

```dotenv
BRAVE_API_KEY=your_brave_key
CONTEXT7_API_KEY=your_context7_key
```

- **Brave**: create a key for the Search plan on the [Brave Search API](https://brave.com/search/api/).
  The extension sets no spending cap: check the credits, quotas and limits of your Brave account.
- **Context7**: create a key from the [Context7 dashboard](https://context7.com/dashboard). Check
  the current quotas on its [plans page](https://context7.com/plans).

The file is reread on every call, so a new key needs no restart. Environment variables of the
same name take precedence, even when empty. Only this file is read, never a project's `.env`.

## Behavior and limits

- **Brave and Context7: one request per call**, with no automatic retry, prefetching or cache, so
  a Context7 resolve followed by a read costs two calls of your quota.
- **`web_fetch`** reads public HTTP(S) pages only: no localhost or private network, no login or
  cookies, no PDF, and no JavaScript execution, so a page that needs it may come back empty or
  partial. It allows 4 redirects, 4 MiB and 20 seconds per page.
- **Long results** are cut at 24,000 bytes or 600 lines. The full text is saved in a private
  temporary file (`pi-web-*/source.txt`) the agent can read; delete these files when you no longer
  need them.
- **Privacy**: search queries go to Brave and documentation queries to Context7. Never put
  secrets, proprietary code or personal data in them. Your keys are only sent to their own
  service.
- **Trust**: pages, snippets and documentation are untrusted data. The agent is told to cite
  sources and not follow instructions found in them, but this is no guarantee against prompt
  injection.
