import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { visibleWidth as tuiVisibleWidth } from '@earendil-works/pi-tui';
import graphiteUi from '../packages/graphite-ui/index.js';
import { createFakePi } from './fixtures/fake-pi.mjs';
import {
  formatCount,
  formatDuration,
  formatFooter,
  formatHeader,
  formatPercent,
  stripAnsi,
  summarizeUsage,
  visibleWidth,
} from '../packages/graphite-ui/format.js';

const plain = (_token, text) => text;
const footerData = {
  cwd: '/Users/alice/work/graphite',
  home: '/Users/alice',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  thinking: 'high',
  branch: 'feature/graphite',
  changedFiles: 7,
  contextPercent: 42.4,
  contextWindow: 200_000,
  inputTokens: 12_345,
  outputTokens: 2_345,
  cost: 0.1278,
  style: plain,
};

test('renders two responsive footer lines with core data before details', () => {
  const wide = formatFooter({ ...footerData, width: 120 });
  assert.equal(wide.length, 2);
  assert.match(wide[0], /^~\/work\/graphite/);
  assert.match(wide[0], /anthropic\/claude-sonnet-4-6 · high$/);
  assert.match(wide[1], /42%\/200k/);
  assert.match(wide[1], /\$0.128/);
  assert.match(wide[1], /feature\/graphite · 7 changed$/);
  assert.equal(visibleWidth(wide[1]), 120);
  assert.match(wide[1], /^42%\/200k · \$0\.128 · ↑12\.3k ↓2\.3k +feature/);
  assert.match(wide[1], /↑12.3k ↓2.3k/);
  assert.doesNotMatch(wide[1], /ctx|cap|used|tok\/s/);

  const medium = formatFooter({ ...footerData, width: 80 });
  assert.match(medium[0], /^~\/work\/graphite +claude-sonnet-4-6 · high$/);
  assert.equal(visibleWidth(medium[0]), 80);
  assert.match(medium[1], /feature\/graphite · 7 changed$/);
  assert.equal(visibleWidth(medium[1]), 80);
  assert.doesNotMatch(medium[0], /anthropic\//);
  assert.match(medium[1], /42%\/200k/);
  assert.match(medium[1], /\$0.128/);
});

test('footer retains the path until the model and thinking consume its space', () => {
  for (const width of [60, 80, 99]) {
    const [first] = formatFooter({ ...footerData, width });
    assert.match(first, /^~\/work\/graphite +claude-sonnet-4-6 · high$/);
  }
  const [crowded] = formatFooter({ ...footerData, width: 30 });
  assert.match(stripAnsi(crowded), /^~\/wo… claude-sonnet-4-6 · high$/);
  const [modelOnly] = formatFooter({ ...footerData, width: 24 });
  assert.equal(stripAnsi(modelOnly), 'claude-sonnet-4-6 · high');
});

test('footer right-aligns the model when no cell remains for the path', () => {
  for (const style of [plain, (_token, text) => `\u001b[34m${text}\u001b[39m`]) {
    const [first] = formatFooter({ ...footerData, width: 25, style });
    assert.equal(stripAnsi(first), ' claude-sonnet-4-6 · high');
    assert.equal(tuiVisibleWidth(first), 25);
  }
});

test('footer never exceeds terminal cell width across narrow and Unicode inputs', () => {
  const widths = [0, 1, 20, 28, 40, 63, 64, 79, 80, 99, 100, 120, 160];
  for (const width of widths) {
    const lines = formatFooter({
      ...footerData,
      width,
      cwd: '/Users/alice/資料/e\u0301/🚀'.repeat(8),
      model: '模型-e\u0301-🚀'.repeat(10),
      branch: 'feature/資料-e\u0301-🚀'.repeat(8),
    });
    assert.equal(lines.length, 2, `line count at ${width}`);
    assert.ok(
      lines.every(line => tuiVisibleWidth(line) <= width),
      `overflow at ${width}`,
    );
  }

  const tiny = formatFooter({ ...footerData, width: 10, branch: 'main' });
  assert.match(tiny[1], /^42%/);
  assert.doesNotMatch(tiny[1], /main|changed/);

  const narrow = formatFooter({ ...footerData, width: 28, branch: 'main' });
  assert.match(narrow[0], /claude/);
  assert.match(narrow[1], /42%\/200k/);
  assert.match(narrow[1], /\$0.128/);
  assert.match(narrow[1], /main/);
  assert.doesNotMatch(narrow.join('\n'), /tok\/s|↑|ctx/);

  const narrowLongBranch = formatFooter({ ...footerData, width: 28 });
  assert.match(narrowLongBranch[1], /feat/);
  assert.doesNotMatch(narrowLongBranch[1], /changed|cap|↑|tok\/s/);
});

test('footer keeps consumption left without Git and aligns styled Git to the right', () => {
  const outside = formatFooter({ ...footerData, width: 80, branch: null, changedFiles: null });
  assert.equal(outside[1], '42%/200k · $0.128 · ↑12.3k ↓2.3k');
  const styled = formatFooter({
    ...footerData,
    width: 80,
    style: (_token, text) => `\u001b[34m${text}\u001b[39m`,
  });
  assert.equal(visibleWidth(styled[1]), 80);
  assert.match(stripAnsi(styled[1]), /feature\/graphite · 7 changed$/);
  const unknown = formatFooter({ ...footerData, width: 80, branch: 'git ?', changedFiles: undefined });
  assert.match(unknown[1], /git \?$/);
  assert.doesNotMatch(unknown[1], /changed/);
});

test('footer reports unknown context honestly and sanitizes labels', () => {
  const lines = formatFooter({
    ...footerData,
    width: 120,
    cwd: '/Users/alice2/project',
    home: '/Users/alice',
    provider: 'bad\u001b[2J\nprovider',
    model: undefined,
    contextPercent: undefined,
    contextWindow: 200_000,
    cost: 0,
  });
  assert.match(lines[0], /no model/);
  assert.match(lines.join(' '), /\?%\/200k/);
  assert.doesNotMatch(lines.join(' '), /ctx|cap|used|tok\/s/);
  assert.match(lines.join(' '), /\$0.000/);
  assert.match(lines[0], /\/Users\/alice2\/project/);
  assert.doesNotMatch(lines.join(''), /\u001b\[2J|\n/);
});

test('aggregates token usage and cost from assistant messages', () => {
  const totals = summarizeUsage([
    { type: 'message', message: { role: 'assistant', usage: { input: 1_200, output: 80, cost: { total: 0.04 } } } },
    { type: 'message', message: { role: 'user' } },
    { type: 'message', message: { role: 'assistant', usage: { input: 800, output: 20, cost: { total: 0.01 } } } },
  ]);
  assert.deepEqual(totals, { inputTokens: 2_000, outputTokens: 100, cost: 0.05 });
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(12_345), '12.3k');
});

test('formats execution durations compactly', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(42_999), '42s');
  assert.equal(formatDuration(62_000), '1m 02s');
  assert.equal(formatDuration(3_723_000), '1h 02m 03s');
});

test('header centers the ASCII PI logo and working path without shortcuts', () => {
  const style = (_token, text) => text;
  const lines = formatHeader({ width: 44, cwd: '/tmp/demo', project: 'demo', style });
  assert.equal(lines[0], '');
  assert.equal(stripAnsi(lines[1]), '                █████████   ');
  assert.deepEqual(
    lines.slice(1, 7).map(line => stripAnsi(line).slice(16)),
    ['█████████   ', '███▀▀▀███   ', '███   ███   ', '██████   ███', '███▀▀▀   ███', '███      ███'],
  );
  assert.match(lines[1], /\u001b\[38;2;255;255;255m/);
  assert.equal(lines[8], '                 /tmp/demo');
  assert.ok(!lines.join('\n').includes('/help'));
  const homeLines = formatHeader({ width: 44, cwd: `${homedir()}/.pi/agent`, style });
  assert.equal(homeLines[8].trim(), '~/.pi/agent');
  for (const width of [0, 1, 6, 13, 14, 25, 44, 80]) {
    assert.ok(
      formatHeader({ width, project: 'long-project-name\nunsafe', style }).every(
        line => visibleWidth(line) <= width && !line.includes('\n'),
      ),
    );
  }
  assert.deepEqual(formatHeader({ width: 13, project: 'pi', style }), ['  π  PI · pi']);
});

test('ANSI styling does not affect visible width', () => {
  const value = '\u001b[38;2;130;170;255mgraphite\u001b[39m';
  assert.equal(stripAnsi(value), 'graphite');
  assert.equal(visibleWidth(value), 8);
  assert.equal(formatPercent(null), null);
});

test('Graphite theme defines every Pi color token', async () => {
  const theme = JSON.parse(
    await readFile(new URL('../packages/graphite-ui/themes/graphite.json', import.meta.url), 'utf8'),
  );
  const required = [
    'accent',
    'border',
    'borderAccent',
    'borderMuted',
    'success',
    'error',
    'warning',
    'muted',
    'dim',
    'text',
    'thinkingText',
    'scrollbarTrack',
    'scrollbarThumb',
    'selectedBg',
    'searchMatchBg',
    'searchMatchText',
    'userMessageBg',
    'userMessageText',
    'customMessageBg',
    'customMessageText',
    'customMessageLabel',
    'toolPendingBg',
    'toolSuccessBg',
    'toolErrorBg',
    'toolTitle',
    'toolOutput',
    'mdHeading',
    'mdLink',
    'mdLinkUrl',
    'mdCode',
    'mdCodeBlock',
    'mdCodeBlockBorder',
    'mdQuote',
    'mdQuoteBorder',
    'mdHr',
    'mdListBullet',
    'toolDiffAdded',
    'toolDiffRemoved',
    'toolDiffContext',
    'syntaxComment',
    'syntaxKeyword',
    'syntaxFunction',
    'syntaxVariable',
    'syntaxString',
    'syntaxNumber',
    'syntaxType',
    'syntaxOperator',
    'syntaxPunctuation',
    'thinkingOff',
    'thinkingMinimal',
    'thinkingLow',
    'thinkingMedium',
    'thinkingHigh',
    'thinkingXhigh',
    'thinkingMax',
    'bashMode',
  ];
  assert.equal(theme.name, 'graphite');
  assert.deepEqual(Object.keys(theme.colors).sort(), required.sort());
});

function createGraphiteHarness(mode = 'tui', options = {}) {
  const statuses = new Map();
  let header;
  let footerComponent;
  let widgetFactory;
  let widgetComponent;
  let indicator;
  let renders = 0;
  let branchListener;
  let branchUnsubscribed = 0;
  const notifications = [];
  const theme = { fg: (_token, text) => text };
  const ctx = {
    mode,
    hasUI: mode === 'tui' || mode === 'rpc',
    cwd: '/tmp/projet',
    model: { id: 'model-pro', provider: 'provider-x', contextWindow: 200_000 },
    thinkingLevel: 'high',
    getContextUsage: () => ({ percent: 25, tokens: 50_000 }),
    sessionManager: options.sessionManager || {
      getSessionId: () => 'session-test',
      getBranch: () =>
        options.branch || [
          {
            type: 'message',
            id: 'assistant-latest',
            message: { role: 'assistant', usage: { input: 1_200, output: 300, cost: { total: 0.02 } } },
          },
        ],
      getEntries: () => options.entries || options.branch || [],
    },
    ui: {
      theme,
      setTheme: name => ({ success: name === 'graphite' }),
      setTitle: () => {},
      setWorkingIndicator: value => {
        indicator = value;
      },
      setHeader: value => {
        header = value;
      },
      setWidget: (_key, value) => {
        widgetComponent?.dispose?.();
        widgetComponent = undefined;
        widgetFactory = value;
        if (typeof value === 'function') {
          widgetComponent = value(
            {
              requestRender: () => {
                renders += 1;
              },
            },
            theme,
          );
        }
      },
      setFooter: value => {
        footerComponent?.dispose?.();
        footerComponent = undefined;
        if (value) {
          footerComponent = value(
            {
              requestRender: () => {
                renders += 1;
              },
            },
            theme,
            {
              getGitBranch: () => 'native-main',
              getExtensionStatuses: () => statuses,
              onBranchChange: listener => {
                branchListener = listener;
                return () => {
                  branchUnsubscribed += 1;
                  branchListener = undefined;
                };
              },
            },
          );
        }
      },
      notify: (message, level) => notifications.push({ message, level }),
    },
  };
  const fake = createFakePi({
    events: options.events,
    appendEntry: (customType, data) => {
      fake.entries.push({ customType, data });
      options.appendEntry?.(customType, data);
    },
  });
  graphiteUi(fake.pi, {
    gitReader: options.gitReader || (async () => ({ state: 'outside', branch: null, changedFiles: null })),
    now: options.now,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
  });
  return {
    fire: (name, event = {}) => fake.fire(name, event, ctx),
    commands: fake.commands,
    entryRenderers: fake.entryRenderers,
    statuses,
    ctx,
    notifications,
    appendedEntries: fake.entries,
    get header() {
      return header;
    },
    get footer() {
      return footerComponent;
    },
    get widget() {
      return widgetComponent;
    },
    get widgetFactory() {
      return widgetFactory;
    },
    get indicator() {
      return indicator;
    },
    get renders() {
      return renders;
    },
    get branchListener() {
      return branchListener;
    },
    get branchUnsubscribed() {
      return branchUnsubscribed;
    },
  };
}

test('Graphite colors the existing context without an extra line and clears state across sessions', async () => {
  const events = new EventEmitter();
  let refreshes = 0;
  events.on('session-compaction:request-state', () => {
    refreshes += 1;
  });
  const harness = createGraphiteHarness('tui', { events });
  await harness.fire('session_start');
  assert.equal(refreshes, 1);
  const colors = { muted: '\u001b[90m', accent: '\u001b[36m', warning: '\u001b[33m' };
  harness.ctx.ui.theme.fg = (token, text) => `${colors[token] ?? '\u001b[37m'}${text}\u001b[39m`;
  harness.ctx.getContextUsage = () => ({ percent: 62, tokens: 124000 });
  const before = harness.renders;
  events.emit('session-compaction:state', {
    percent: 62,
    lowPercent: 60,
    highPercent: 94,
    phase: 'available',
    enabled: true,
  });
  assert.ok(harness.renders > before);
  const lines = harness.footer.render(120);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith(`${colors.accent}62%\u001b[39m`));
  assert.doesNotMatch(lines.map(stripAnsi).join('\n'), /compaction|L.*H/);
  events.emit('session-compaction:state', {
    percent: null,
    lowPercent: 60,
    highPercent: 94,
    phase: 'compacting',
    enabled: true,
  });
  assert.equal(harness.footer.render(120).length, 2);
  await harness.fire('session_shutdown');
  await harness.fire('session_start');
  assert.equal(harness.footer.render(120).length, 2);
  assert.equal(refreshes, 2);
  assert.ok(harness.footer.render(120)[1].startsWith(`${colors.muted}62%\u001b[39m`));
});

test('Graphite installs a fresh two-line footer and preserves native statuses', async () => {
  const harness = createGraphiteHarness();
  await harness.fire('session_start');

  assert.equal(harness.commands.has('graphite-ui'), true);
  assert.deepEqual(harness.indicator, {
    frames: ['⠏', '⠛', '⠹', '⢸', '⣰', '⣤', '⣆', '⡇'],
    intervalMs: 110,
  });
  // Each of the eight dots participates equally over one full rotation.
  const masks = harness.indicator.frames.map(frame => frame.codePointAt(0) - 0x2800);
  for (const mask of masks) {
    assert.equal(mask.toString(2).replaceAll('0', '').length, 4);
  }
  for (let bit = 0; bit < 8; bit++) {
    assert.equal(masks.filter(mask => mask & (1 << bit)).length, 4);
  }
  const headerLines = harness.header({}, harness.ctx.ui.theme).render(80);
  assert.equal(stripAnsi(headerLines[1]).trim(), '█████████');
  assert.equal(headerLines[8].trim(), harness.ctx.cwd);
  harness.statuses.set('z-last', '\u001b[31mred\u001b[0m\nsecond line');
  harness.statuses.set('a-first', 'first');
  const lines = harness.footer.render(80);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /model-pro · high$/);
  assert.equal(visibleWidth(lines[0]), 80);
  assert.match(lines[1], /25%\/200k · \$0.020/);
  assert.deepEqual(lines.slice(2).map(stripAnsi), ['first', 'red', 'second line']);
  assert.ok(lines.every(line => tuiVisibleWidth(line) <= 80));

  harness.ctx.model = { id: 'model-next', provider: 'provider-y', contextWindow: 100_000 };
  harness.ctx.thinkingLevel = 'low';
  harness.ctx.getContextUsage = () => ({ percent: 51, tokens: 51_000 });
  await harness.fire('model_select');
  await harness.fire('thinking_level_select');
  await harness.fire('session_compact');
  await harness.fire('session_tree');
  assert.ok(harness.renders >= 4);
  assert.match(harness.footer.render(80)[0], /model-next · low$/);
  assert.match(harness.footer.render(80)[1], /51%\/100k/);
});

test('Graphite widget keeps the live run time only while running, then leaves the duration in the transcript', async () => {
  let now = 10_000;
  const manager = SessionManager.inMemory('/tmp/project');
  const harness = createGraphiteHarness('tui', {
    sessionManager: manager,
    now: () => now,
    appendEntry: (type, data) => manager.appendCustomEntry(type, data),
    setInterval: () => 1,
    clearInterval: () => {},
  });
  await harness.fire('session_start');
  assert.deepEqual(harness.widget.render(80), []);

  await harness.fire('agent_start');
  now += 65_000;
  assert.equal(harness.widget.render(80)[0], ' ⏱ 1m 05s');
  await harness.fire('agent_settled');
  assert.deepEqual(harness.widget.render(80), []);

  await harness.fire('agent_start');
  assert.equal(harness.widget.render(80)[0], ' ⏱ 0s · 1m 05s');
  now += 10_000;
  await harness.fire('agent_settled');
  assert.equal(harness.widget.render(80)[0], ' Total 1m 15s');
  const timing = manager.getBranch().find(entry => entry.customType === 'graphite-ui-timing');
  assert.deepEqual(
    harness.entryRenderers.get('graphite-ui-timing')(timing, { expanded: false }, harness.ctx.ui.theme).render(80),
    [` ⏱ 1m 05s · run duration · ${new Date(75_000).toTimeString().slice(0, 8)}`],
  );
});

test('Graphite saves the local completion time and preserves it when /tree restores the timing', async () => {
  let now = new Date(2026, 5, 12, 14, 7, 3).getTime();
  const response = { type: 'message', id: 'response', message: { role: 'assistant' } };
  const entries = [response];
  const branch = [response];
  const harness = createGraphiteHarness('tui', {
    now: () => now,
    entries,
    branch,
    setInterval: () => 1,
    clearInterval: () => {},
  });
  await harness.fire('session_start');
  await harness.fire('agent_start');
  now += 65_000;
  await harness.fire('agent_settled');
  const saved = harness.appendedEntries[0];
  assert.equal(saved.data.endedAt, now);
  const timing = { type: 'custom', id: 'timing', ...saved };
  const renderer = harness.entryRenderers.get('graphite-ui-timing');
  assert.deepEqual(renderer(timing, {}, harness.ctx.ui.theme).render(80), [' ⏱ 1m 05s · run duration · 14:08:08']);
  entries.push(timing);
  await harness.fire('session_tree');
  assert.equal(harness.appendedEntries[1].data.endedAt, now);
  assert.deepEqual(renderer(harness.appendedEntries[1], {}, harness.ctx.ui.theme).render(80), [
    ' ⏱ 1m 05s · run duration · 14:08:08',
  ]);
  // Old entries have no known completion time: do not invent one.
  assert.deepEqual(renderer({ data: { durationMs: 65_000 } }, {}, harness.ctx.ui.theme).render(80), [
    ' ⏱ 1m 05s · run duration',
  ]);
});

test('Graphite hides the compaction count until a successful compaction exists', async () => {
  const harness = createGraphiteHarness('tui', {
    now: () => 10_000,
    setInterval: () => 1,
    clearInterval: () => {},
  });
  await harness.fire('session_start');
  assert.deepEqual(harness.widget.render(80), []);

  await harness.fire('agent_start');
  assert.equal(harness.widget.render(80)[0], ' ⏱ 0s');
});

test('Graphite timer shows successful compactions since the session began', async () => {
  const entries = [{ type: 'compaction' }, { type: 'message', id: 'assistant-latest', message: { role: 'assistant' } }];
  const harness = createGraphiteHarness('tui', { entries });
  await harness.fire('session_start');
  assert.equal(harness.widget.render(80)[0], ' 1 comp');
  await harness.fire('agent_start');
  assert.equal(harness.widget.render(80)[0], ' ⏱ 0s · 1 comp');
  await harness.fire('agent_settled');
  assert.equal(harness.widget.render(80)[0], ' 1 comp');

  entries.push({ type: 'compaction' });
  await harness.fire('session_compact');
  assert.equal(harness.widget.render(80)[0], ' 2 comp');
  await harness.fire('agent_start');
  assert.equal(harness.widget.render(80)[0], ' ⏱ 0s · 0s · 2 comp');
  await harness.fire('agent_settled');
});

test('Graphite timer spans the full agent run and persists session totals', async () => {
  let now = 10_000;
  let tick;
  let cleared = 0;
  const harness = createGraphiteHarness('tui', {
    now: () => now,
    setInterval: callback => {
      tick = callback;
      return 123;
    },
    clearInterval: id => {
      assert.equal(id, 123);
      cleared += 1;
    },
    branch: [
      { type: 'custom', customType: 'graphite-ui-timing', data: { durationMs: 30_000 } },
      { type: 'compaction' },
      { type: 'custom', customType: 'graphite-ui-timing', data: { durationMs: 45_000 } },
      { type: 'message', id: 'assistant-final', message: { role: 'assistant' } },
    ],
  });
  await harness.fire('session_start');
  assert.equal(harness.widget.render(80)[0], ' Total 1m 15s · 1 comp');

  await harness.fire('before_agent_start');
  assert.equal(harness.widget.render(80)[0], ' ⏱ 0s · 1m 15s · 1 comp');
  now += 62_000;
  tick();
  assert.equal(harness.widget.render(80)[0], ' ⏱ 1m 02s · 2m 17s · 1 comp');

  // A compaction must not reset the active run.
  await harness.fire('session_compact');
  now += 3_000;
  await harness.fire('agent_settled');
  assert.equal(harness.widget.render(80)[0], ' Total 2m 20s · 1 comp');
  assert.deepEqual(harness.appendedEntries, [
    {
      customType: 'graphite-ui-timing',
      data: {
        durationMs: 65_000,
        endedAt: 75_000,
        anchorMessageId: 'assistant-final',
        timingId: 'session-test:10000:4',
      },
    },
  ]);
  assert.equal(cleared, 1);
});

test('Graphite displays saved run durations in the scrollable transcript without model messages', async () => {
  let now = 10_000;
  const manager = SessionManager.inMemory('/tmp/project');
  const harness = createGraphiteHarness('tui', {
    sessionManager: manager,
    now: () => now,
    appendEntry: (type, data) => manager.appendCustomEntry(type, data),
    setInterval: () => 1,
    clearInterval: () => {},
  });
  await harness.fire('session_start');
  await harness.fire('agent_start');
  now += 65_000;
  await harness.fire('agent_settled');

  const entry = manager.getBranch().at(-1);
  assert.equal(entry.type, 'custom');
  assert.equal(entry.customType, 'graphite-ui-timing');
  const renderer = harness.entryRenderers.get('graphite-ui-timing');
  assert.equal(typeof renderer, 'function');
  assert.deepEqual(renderer(entry, { expanded: false }, harness.ctx.ui.theme).render(80), [
    ` ⏱ 1m 05s · run duration · ${new Date(75_000).toTimeString().slice(0, 8)}`,
  ]);
  const narrow = renderer(entry, { expanded: false }, harness.ctx.ui.theme).render(8);
  assert.ok(narrow.every(line => tuiVisibleWidth(line) <= 8));
  assert.match(stripAnsi(narrow[0]), /^ ⏱ 1m/);
  assert.deepEqual(manager.buildSessionContext().messages, []);

  const resumed = createGraphiteHarness('tui', { sessionManager: manager });
  await resumed.fire('session_start', { reason: 'resume' });
  assert.deepEqual(
    resumed.entryRenderers
      .get('graphite-ui-timing')(manager.getBranch().at(-1), { expanded: false }, resumed.ctx.ui.theme)
      .render(80),
    [` ⏱ 1m 05s · run duration · ${new Date(75_000).toTimeString().slice(0, 8)}`],
  );
});

test('Graphite keeps an anchored duration when /tree selects its final response', async () => {
  const response = { type: 'message', id: 'assistant-final', message: { role: 'assistant' } };
  const timing = {
    type: 'custom',
    id: 'timing-after-response',
    customType: 'graphite-ui-timing',
    data: { durationMs: 1_000, anchorMessageId: response.id },
  };
  const branch = [response, timing];
  const harness = createGraphiteHarness('tui', { branch, entries: [response, timing] });
  await harness.fire('session_start');
  assert.deepEqual(harness.widget.render(80), []);

  branch.pop(); // /tree places the leaf on the response, before the custom timing entry.
  await harness.fire('session_tree');
  assert.deepEqual(harness.widget.render(80), []);
  assert.deepEqual(harness.appendedEntries, [
    {
      customType: 'graphite-ui-timing',
      data: {
        durationMs: 1_000,
        anchorMessageId: 'assistant-final',
        timingId: 'timing-after-response',
      },
    },
  ]);
});

test('a real Pi branch copy preserves timing when forked at an assistant response', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'graphite-timer-fork-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = SessionManager.create('/tmp/project', directory);
  source.appendMessage({ role: 'user', content: 'prompt', timestamp: 1 });
  const responseId = source.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'response' }],
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 2,
  });
  source.appendCustomEntry('graphite-ui-timing', {
    durationMs: 1_000,
    anchorMessageId: responseId,
    timingId: 'source-run',
    endedAt: new Date(2026, 5, 12, 14, 8, 8).getTime(),
  });
  const sourcePath = source.getSessionFile();
  const copied = SessionManager.open(sourcePath, directory);
  const forkPath = copied.createBranchedSession(responseId);
  const forkManager = SessionManager.open(forkPath, directory);
  assert.equal(
    forkManager.getBranch().some(entry => entry.type === 'custom'),
    false,
  );

  const harness = createGraphiteHarness('tui', {
    sessionManager: forkManager,
    appendEntry: (customType, data) => forkManager.appendCustomEntry(customType, data),
  });
  await harness.fire('session_start', {
    reason: 'fork',
    previousSessionFile: sourcePath,
  });
  assert.deepEqual(harness.widget.render(80), []);
  const reopenedFork = SessionManager.open(forkPath, directory);
  const forkTiming = reopenedFork
    .getBranch()
    .find(entry => entry.type === 'custom' && entry.customType === 'graphite-ui-timing');
  assert.equal(forkTiming.data.endedAt, new Date(2026, 5, 12, 14, 8, 8).getTime());
});

test('an in-memory Pi fork preserves timing without previousSessionFile', async () => {
  const manager = SessionManager.inMemory('/tmp/project');
  manager.appendMessage({ role: 'user', content: 'prompt', timestamp: 1 });
  const responseId = manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'response' }],
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 2,
  });
  manager.appendCustomEntry('graphite-ui-timing', {
    durationMs: 1_000,
    anchorMessageId: responseId,
    timingId: 'memory-run',
    endedAt: new Date(2026, 5, 12, 14, 8, 8).getTime(),
  });

  const source = createGraphiteHarness('tui', { sessionManager: manager });
  await source.fire('session_start', { reason: 'startup' });
  await source.fire('session_before_fork', { entryId: responseId, position: 'at' });
  manager.createBranchedSession(responseId);
  assert.equal(
    manager.getBranch().some(entry => entry.type === 'custom'),
    false,
  );

  const fork = createGraphiteHarness('tui', {
    sessionManager: manager,
    appendEntry: (customType, data) => manager.appendCustomEntry(customType, data),
  });
  await fork.fire('session_start', { reason: 'fork' });
  assert.deepEqual(fork.widget.render(80), []);
  const forkTiming = manager
    .getBranch()
    .find(entry => entry.type === 'custom' && entry.customType === 'graphite-ui-timing');
  assert.equal(forkTiming.data.endedAt, new Date(2026, 5, 12, 14, 8, 8).getTime());
});

test('pre-prompt automatic compaction is included in the execution duration', async () => {
  let now = 20_000;
  const harness = createGraphiteHarness('tui', {
    now: () => now,
    setInterval: () => 789,
    clearInterval: () => {},
  });
  await harness.fire('session_start');

  await harness.fire('session_before_compact', { reason: 'threshold' });
  now += 5_000;
  await harness.fire('before_agent_start');
  now += 2_000;
  await harness.fire('agent_settled');

  assert.deepEqual(harness.appendedEntries, [
    {
      customType: 'graphite-ui-timing',
      data: {
        durationMs: 7_000,
        endedAt: 27_000,
        anchorMessageId: 'assistant-latest',
        timingId: 'session-test:20000:0',
      },
    },
  ]);
});

test('agent_start provides timing fallback and agent_settled always refreshes Git', async () => {
  let now = 5_000;
  let gitReads = 0;
  const harness = createGraphiteHarness('tui', {
    now: () => now,
    setInterval: () => 456,
    clearInterval: () => {},
    gitReader: async () => {
      gitReads += 1;
      return { state: 'outside', branch: null, changedFiles: null };
    },
  });
  await harness.fire('session_start');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gitReads, 1);

  await harness.fire('agent_start');
  now += 2_000;
  await harness.fire('agent_settled');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.appendedEntries, [
    {
      customType: 'graphite-ui-timing',
      data: {
        durationMs: 2_000,
        endedAt: 7_000,
        anchorMessageId: 'assistant-latest',
        timingId: 'session-test:5000:0',
      },
    },
  ]);
  assert.equal(gitReads, 2);

  // Even an execution that started before the extension observed it gets a final Git refresh.
  await harness.fire('agent_settled');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gitReads, 3);
});

test('Graphite timer widget is removed with the custom UI', async () => {
  const harness = createGraphiteHarness();
  await harness.fire('session_start');
  assert.ok(harness.widget);
  await harness.commands.get('graphite-ui').handler('off', harness.ctx);
  assert.equal(harness.widget, undefined);
});

test('Graphite refreshes Git asynchronously, coalesces activity and ignores stale results', async () => {
  const reads = [];
  const reader = (_cwd, { signal }) => new Promise(resolve => reads.push({ resolve, signal }));
  const harness = createGraphiteHarness('tui', { gitReader: reader });
  await harness.fire('session_start');
  assert.equal(reads.length, 1);

  await harness.fire('input');
  await harness.fire('tool_execution_end');
  assert.equal(reads.length, 1);
  reads[0].resolve({ state: 'valid', branch: 'feature/local', changedFiles: 3 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 2);
  reads[1].resolve({ state: 'valid', branch: 'feature/local', changedFiles: 4 });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(harness.footer.render(80)[1], /feature\/local/);
  assert.match(harness.footer.render(80)[1], /4 changed/);

  await harness.fire('input');
  assert.equal(reads.length, 3);
  const rendersBeforeOff = harness.renders;
  await harness.commands.get('graphite-ui').handler('off', harness.ctx);
  assert.equal(reads[2].signal.aborted, true);
  reads[2].resolve({ state: 'valid', branch: 'stale', changedFiles: 99 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.renders, rendersBeforeOff);

  await harness.commands.get('graphite-ui').handler('on', harness.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 4);
  reads[3].resolve({ state: 'unknown', branch: null, changedFiles: null, error: 'timeout' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(harness.footer.render(80)[1], /git \?/);
});

test('disposing the footer cancels Git and makes late callbacks inert', async () => {
  const reads = [];
  const harness = createGraphiteHarness('tui', {
    gitReader: (_cwd, { signal }) => new Promise(resolve => reads.push({ resolve, signal })),
  });
  await harness.fire('session_start');
  const rendersBeforeDispose = harness.renders;
  harness.footer.dispose();
  assert.equal(reads[0].signal.aborted, true);
  reads[0].resolve({ state: 'valid', branch: 'stale', changedFiles: 9 });
  await new Promise(resolve => setImmediate(resolve));
  await harness.fire('input');
  assert.equal(reads.length, 1);
  assert.equal(harness.renders, rendersBeforeDispose);
});

test('/graphite-ui off restores remaining Graphite components after another footer replaces it', async () => {
  const harness = createGraphiteHarness();
  await harness.fire('session_start');
  harness.ctx.ui.setFooter(() => ({ render: () => ['external'], invalidate() {} }));
  assert.equal(harness.footer.render(80)[0], 'external');

  await harness.commands.get('graphite-ui').handler('off', harness.ctx);
  assert.equal(harness.header, undefined);
  assert.equal(harness.indicator, undefined);
  assert.equal(harness.footer.render(80)[0], 'external');
});

test('/graphite-ui refresh waits for Git and reports explicit errors without a model turn', async () => {
  const harness = createGraphiteHarness('tui', {
    gitReader: async () => ({ state: 'unknown', branch: null, changedFiles: null, error: 'Git timed out' }),
  });
  await harness.fire('session_start');
  await harness.commands.get('graphite-ui').handler('refresh', {
    ...harness.ctx,
    sessionManager: { ...harness.ctx.sessionManager, getSessionId: () => 'command-context-wrapper' },
  });
  assert.match(harness.notifications.at(-1).message, /Git timed out/);

  const rpc = createGraphiteHarness('rpc');
  await rpc.fire('session_start');
  await rpc.commands.get('graphite-ui').handler('refresh', rpc.ctx);
  assert.match(rpc.notifications.at(-1).message, /TUI mode/);
});

test('Graphite lifecycle is idempotent and never installs custom TUI outside TUI mode', async () => {
  const harness = createGraphiteHarness();
  await harness.fire('session_start');
  const firstFooter = harness.footer;
  await harness.commands.get('graphite-ui').handler('off', harness.ctx);
  assert.equal(harness.footer, undefined);
  assert.equal(harness.branchUnsubscribed, 1);
  await harness.commands.get('graphite-ui').handler('off', harness.ctx);
  assert.equal(harness.branchUnsubscribed, 1);
  await harness.commands.get('graphite-ui').handler('on', harness.ctx);
  assert.notEqual(harness.footer, firstFooter);
  await harness.fire('session_shutdown');
  assert.equal(harness.footer, undefined);
  assert.equal(harness.branchUnsubscribed, 2);

  for (const mode of ['rpc', 'json', 'print']) {
    const other = createGraphiteHarness(mode);
    await other.fire('session_start');
    assert.equal(other.footer, undefined, mode);
    await other.commands.get('graphite-ui').handler('on', other.ctx);
    assert.equal(other.footer, undefined, mode);
  }
});
