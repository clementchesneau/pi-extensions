import assert from 'node:assert/strict';
import test from 'node:test';
import { compositeTuiLine, encodeITerm2, encodeKitty } from '@earendil-works/pi-tui';
import { createTasksUI } from '../packages/background-tasks/ui.js';
import { createSubagentUI } from '../packages/subagents/ui.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const theme = { fg: (_color, text) => text };

for (const kind of ['tasks', 'subagents']) {
  for (const image of [encodeKitty('AAAA', { imageId: 42, rows: 2 }), `\x1b[1A${encodeITerm2('AAAA')}\x1b[1B`]) {
    test(`${kind} hides transcript graphics in list/detail and restores them on close (${image.includes('_G') ? 'kitty' : 'iterm2'})`, async t => {
      let transcript = [image, '', 'parent transcript'];
      const originalRender = () => transcript;
      const originalComposite = (lines, overlay) =>
        overlay.map((line, i) => compositeTuiLine(lines[i] ?? '', line, 0, 80, 80));
      const tui = {
        terminal: { rows: 20 },
        render: originalRender,
        compositeOverlays: originalComposite,
        requestRender() {},
      };
      const screens = [];
      const ctx = {
        mode: 'tui',
        ui: {
          setWidget() {},
          notify() {},
          custom: (factory, options) =>
            new Promise(resolve => {
              const component = factory(tui, theme, {}, resolve);
              screens.push({ component, options });
            }),
        },
      };
      const task = {
        id: 'task-1',
        title: 'Mission',
        state: 'completed',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      const agent = {
        agentId: 'A1',
        alias: 'A1',
        title: 'Mission',
        runs: [],
        run: { runId: 'R1', state: 'completed' },
      };
      const manager = {
        subscribe: () => () => {},
        list: () => [task],
        get: () => task,
        output: async () => ({ text: 'task output', start: 0, nextOffset: 11, unavailableBefore: 0 }),
        compactAgents: () => [agent],
        activeAgentIds: () => [],
        findAgent: () => agent,
        result: async () => ({ text: 'agent output' }),
        transcript: async () => ({ text: '' }),
      };
      const ui =
        kind === 'tasks'
          ? createTasksUI(ctx, manager)
          : createSubagentUI({ ctx, manager, getConfig: async () => ({ maxConcurrent: 4 }) });
      t.after(() => ui.dispose());
      const opened = ui.open();
      const assertCovered = () => {
        const overlay = screens.at(-1).component.render(80);
        const lines = tui.render(80);
        const composed = tui.compositeOverlays(lines, overlay).join('\n');
        assert.doesNotMatch(composed, /\x1b_G|\x1b\]1337;File=/);
        assert.match(composed, /Mission|Tasks|Subagents/);
        assert.equal(lines.length, transcript.length, 'image masking preserves transcript geometry');
      };
      assertCovered();
      screens.at(-1).component.handleInput('\r');
      await tick();
      assertCovered();
      transcript = [image, '', 'parent transcript updated', image];
      tui.terminal.rows = 24;
      assertCovered();
      screens.at(-1).component.handleInput('\x1b');
      await tick();
      assertCovered();
      screens.at(-1).component.handleInput('\x1b');
      await opened;
      assert.equal(tui.compositeOverlays, originalComposite);
      assert.deepEqual(tui.render(80), transcript);
      const reopened = ui.open();
      assertCovered();
      ui.dispose();
      await reopened;
      assert.equal(tui.compositeOverlays, originalComposite, 'shutdown restores graphics too');
    });
  }
}
