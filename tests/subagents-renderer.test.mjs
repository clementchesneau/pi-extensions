import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const hostEntry = process.env.PI_TEST_HOST_ENTRY;
const sdk = await import(hostEntry ? pathToFileURL(hostEntry).href : '@earendil-works/pi-coding-agent');
const tuiSdk = await import(
  hostEntry
    ? pathToFileURL(createRequire(pathToFileURL(hostEntry)).resolve('@earendil-works/pi-tui')).href
    : '@earendil-works/pi-tui'
);
const { TuiMainScreen, TuiAltScreen } = tuiSdk;
import { createSubagentUI } from '../packages/subagents/ui.js';

sdk.initTheme('dark');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Controlled VT boundary: consume the actual renderer's cursor movements, CR/LF,
// erasure and autowrap. SGR/OSC have no cell width and do not move the cursor.
function terminal(rows = 24, columns = 80) {
  let y = 0,
    x = 0,
    wrap = true,
    pendingWrap = false;
  let screen = Array.from({ length: rows }, () => Array(columns).fill(' '));
  const nextLine = () => {
    if (++y >= rows) {
      screen.shift();
      screen.push(Array(columns).fill(' '));
      y = rows - 1;
    }
  };
  return {
    rows,
    columns,
    start() {},
    stop() {},
    hideCursor() {},
    showCursor() {},
    moveTo() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    text: () => screen.map(line => line.join('')).join('\n'),
    write(data) {
      for (let i = 0; i < data.length;) {
        const remaining = data.slice(i);
        const csi = /^\x1b\[([0-9;?]*)([ -/]*)([@-~])/.exec(remaining);
        if (csi) {
          const [, values, , command] = csi;
          const args = values
            .replace(/^\?/, '')
            .split(';')
            .map(value => Number(value) || 1);
          if ('ABCDGHf'.includes(command)) pendingWrap = false;
          if (command === 'A') y = Math.max(0, y - args[0]);
          if (command === 'B') y = Math.min(rows - 1, y + args[0]);
          if (command === 'C') x = Math.min(columns - 1, x + args[0]);
          if (command === 'D') x = Math.max(0, x - args[0]);
          if (command === 'G') x = Math.min(columns - 1, args[0] - 1);
          if (command === 'H' || command === 'f') {
            y = Math.min(rows - 1, args[0] - 1);
            x = Math.min(columns - 1, (args[1] ?? 1) - 1);
          }
          if (command === 'J' && values === '2') screen = Array.from({ length: rows }, () => Array(columns).fill(' '));
          if (command === 'K') {
            const mode = Number(values) || 0;
            const begin = mode === 2 || mode === 1 ? 0 : x;
            const end = mode === 1 ? x + 1 : columns;
            screen[y].fill(' ', begin, end);
          }
          if ((command === 'h' || command === 'l') && values === '?7') wrap = command === 'h';
          i += csi[0].length;
          continue;
        }
        const osc = /^\x1b\][\s\S]*?(?:\x07|\x1b\\)/.exec(remaining);
        if (osc) {
          i += osc[0].length;
          continue;
        }
        const char = String.fromCodePoint(data.codePointAt(i));
        i += char.length;
        if (char === '\r') {
          x = 0;
          pendingWrap = false;
        } else if (char === '\n') {
          nextLine();
          pendingWrap = false;
        } else if (char >= ' ') {
          if (pendingWrap && wrap) {
            x = 0;
            nextLine();
          }
          pendingWrap = false;
          screen[y][x] = char;
          if (x < columns - 1) x++;
          else pendingWrap = true;
        }
      }
    },
  };
}

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
  test(`${Renderer.name} keeps the activity header on screen through arrow scrolling and parent growth`, async t => {
    const term = terminal();
    const tui = new Renderer(term);
    let parentLines = Array(60).fill('PARENT');
    tui.addChild({ render: () => parentLines, invalidate() {} });
    tui.start();
    tui.renderNow();
    const agent = {
      agentId: 'id',
      alias: 'A1',
      title: 'FIXED HEADER',
      task: 'work',
      runs: [],
      run: { runId: 'run', state: 'running' },
    };
    const listeners = new Set();
    const archive =
      Array.from({ length: 40 }, (_, index) =>
        JSON.stringify({
          message: {
            role: 'assistant',
            timestamp: index,
            content: [
              { type: 'text', text: `entry-${index}\n\n| Column | Value |\n| --- | --- |\n| line | ${index} |` },
            ],
          },
        }),
      ).join('\n') + '\n';
    const manager = {
      compactAgents: () => [agent],
      findAgent: () => agent,
      activeAgentIds: () => ['id'],
      subscribe: callback => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      transcript: async ({ cursor = 0 }) => ({ text: archive.slice(cursor) }),
      result: async () => ({ text: '' }),
    };
    const ui = createSubagentUI({
      sdk,
      manager,
      getConfig: async () => ({ maxConcurrent: 4 }),
      ctx: {
        mode: 'tui',
        ui: {
          setWidget() {},
          custom: (factory, options) =>
            new Promise(resolve => {
              let handle;
              const component = factory(tui, { fg: (_name, text) => text }, {}, value => {
                handle.hide();
                resolve(value);
              });
              handle = tui.showOverlay(component, options.overlayOptions);
            }),
        },
      },
    });
    const opened = ui.open();
    t.after(async () => {
      ui.dispose();
      await opened;
      tui.stop();
    });
    tui.getFocusedComponent().handleInput('\r');
    await tick();
    const assertHeader = () => {
      tui.renderNow();
      assert.match(term.text().split('\n').slice(0, 6).join('\n'), /FIXED HEADER/);
      assert.match(term.text().split('\n').slice(0, 6).join('\n'), /Activity/);
    };
    assertHeader();
    for (let step = 0; step < 80; step++) {
      tui.getFocusedComponent().handleInput(step < 40 ? '\x1b[A' : '\x1b[B');
      if (step % 4 === 0) {
        parentLines.push('PARENT GROWTH');
        for (const callback of listeners) callback({ agentId: 'id' });
      }
      await tick();
      assertHeader();
    }
  });
}
