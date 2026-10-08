# Web

Web tools for the agent, independent of your AI provider: Brave search, reading of pages, PDFs,
images and GitHub URLs, and versioned library documentation from Context7.

```sh
pi install npm:@clement_chsn/pi-web
```

| Tool | Purpose | Key |
| --- | --- | --- |
| `web_search` | Search the web with Brave: titles, URLs, snippets | `BRAVE_API_KEY` |
| `web_fetch` | Read a public URL: page as Markdown (HTML, text, Markdown, JSON), PDF text, image, or GitHub repository, directory, file, issue or pull request | None |
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
- **`web_fetch`** reads public HTTP(S) URLs only: no localhost or private network, no login or
  cookies, and no JavaScript execution, so a page that needs it may come back empty or partial.
  It allows 4 redirects, 20 seconds and 4 MiB per URL, 20 MiB for a PDF; the several GitHub API
  requests behind one URL share these limits.
- **PDF**: the text is extracted locally with unpdf and marked by page, in a worker thread limited
  to 20 seconds and 512 MB of heap that stops when the call is cancelled. There is no OCR: a
  scanned PDF, or one whose fonts cannot be decoded, is reported as having no text, and a
  password-protected PDF is refused.
- **Images**: PNG, JPEG, GIF and WebP reach the model as images when the current model accepts
  them; Pi resizes them before sending. The format comes from the file's signature, not the
  declared type; an image Pi cannot decode, such as a truncated file, and other formats are
  refused.
- **GitHub**: a repository gives its README and root files (a `github.com` path that is not a
  repository, such as an advisory, is read as an ordinary page), a `tree` URL lists that directory, a
  `blob` URL reads the raw file, and an issue or pull request gives its description and first 100
  comments, without inline review comments. GitHub's API allows 60 requests per hour without a
  token: a repository costs 2, an issue or pull request 1 or 2. Private repositories, and branch
  names containing `/` in `tree` URLs, are not supported: the agent is told to use `gh` or `git`
  through the shell instead.
- **Long results** are cut at 24,000 bytes or 600 lines. The full text is saved in a private
  temporary file (`pi-web-*/source.txt`) the agent can read; delete these files when you no longer
  need them.
- **Privacy**: search queries go to Brave and documentation queries to Context7. Never put
  secrets, proprietary code or personal data in them. Your keys are only sent to their own
  service.
- **Trust**: pages, snippets and documentation are untrusted data. The agent is told to cite
  sources and not follow instructions found in them, but this is no guarantee against prompt
  injection.
