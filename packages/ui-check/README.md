# UI check

Lets the agent open your web UI in a headless Chromium, click through it, take screenshots and
read console and network errors, to check its own front-end work. Runs locally through
Playwright; the screenshots go to the model of your conversation.

```sh
pi install npm:@clement_chsn/pi-ui-check
npx playwright@1.63.0 install chromium
```

The second command downloads the Chromium matching this package's Playwright; the browser is never
downloaded behind your back. On Linux, Chromium may also need system libraries: see Playwright's
installation instructions. Screenshots need a model that accepts images; a text-only model can
still use the accessibility snapshots and errors.

## What the agent gets

| Tool | Purpose |
| --- | --- |
| `browser_open` | Open a URL (localhost included) and return an accessibility snapshot and errors |
| `browser_act` | Click, hover, fill, press a key, select, check, scroll, wait for an element, or resize the viewport |
| `browser_inspect` | Snapshot the page or one element, optionally with a screenshot |
| `browser_close` | Close the browser and drop its cookies and state |

Elements are targeted by accessible role and name, for example
`{"role":"button","name":"Save"}`, or by CSS selector; an ambiguous target fails rather than
clicking the first match. The agent starts your dev server itself with the project's commands:
the extension only opens the URL it is given.

The snapshot also lets the agent read a public page whose content only appears once JavaScript
runs. It is taken when the document loads, so the agent inspects the page again when its data
arrives later. Such a page runs its own JavaScript in the isolated browser: Chromium blocks
its requests to localhost and private networks, but the page can still navigate the browser to a
local address, which sends one GET request there, as it could in your own browser.

Using the browser is up to the agent: no hook forces a check, and an observation is not a
verdict that the UI matches your request.

## Limits

- One page in a fresh context, Chromium only: no tabs, file uploads or downloads, native dialogs
  or canvas clicks by coordinates. A narrow viewport is not a real mobile device.
- Viewport from 240×240 to 1920×1440. Screenshots cover the viewport or one element, not a full
  long page.
- Errors are the last 50 console messages, exceptions, failed requests and HTTP errors seen since
  opening, not proof that there are none.
- Screenshots and long snapshots are saved in private temporary folders (`pi-ui-check-*`) that are
  not cleaned up automatically.

## Safety

- **Pages run their JavaScript and can reach any network**, including local ones. The browser
  context is not a security sandbox.
- Chromium runs inside its operating-system sandbox, which keeps a page exploiting a browser flaw
  away from your files. Where the system cannot provide it, such as Linux without unprivileged
  user namespaces, as root or in some containers, Chromium runs without it and every
  `browser_open` result says so.
- A click or a navigation can change server data. Use test environments and test accounts.
- Page text, URLs and screenshots go to your model provider and stay in the Pi history; images
  also cost context and tokens.
