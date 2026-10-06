import assert from 'node:assert/strict';
import test from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { createSubagentUI } from '../packages/subagents/ui.js';
import { SubagentManager } from '../packages/subagents/manager.js';

initTheme('dark');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Informations updates cost, token breakdown and context while the child is still running', async t => {
  let listener;
  const manager = new SubagentManager({
    ownerSessionId: 'session',
    branchId: 'branch',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    readTranscript: async () => ({ text: '' }),
    createRuntime: async () => ({
      subscribe(callback) {
        listener = callback;
      },
      prompt: async () => ({ runId: 'runtime', result: new Promise(() => {}) }),
      stop: async () => {},
    }),
  });
  const started = await manager.start({ title: 'Counters', task: 'work' });
  let component;
  let repaint = 0;
  const ui = createSubagentUI({
    manager,
    ctx: {
      mode: 'tui',
      cwd: process.cwd(),
      ui: {
        setWidget() {},
        custom: factory =>
          new Promise(done => {
            component = factory(
              {
                terminal: { rows: 45 },
                requestRender() {
                  repaint++;
                },
              },
              { fg: (_name, text) => text },
              {},
              done,
            );
          }),
      },
    },
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
  });
  const opened = ui.open();
  t.after(async () => {
    ui.dispose();
    await opened;
    await manager.shutdown();
  });
  component.handleInput('\r');
  await tick();
  component.handleInput('i');
  assert.match(component.render(120).join('\n'), /Context · unavailable/);
  const before = repaint;
  listener({
    type: 'telemetry',
    runId: 'runtime',
    data: {
      usage: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 50, totalTokens: 1550, cost: { total: 0.0123 } },
      contextUsage: { tokens: 1550, contextWindow: 10000, percent: 15.5 },
      updatedAt: Date.now(),
    },
  });
  await tick();
  const text = component.render(120).join('\n');
  assert.match(text, /1,550 tokens/);
  assert.match(text, /\$0\.0123/);
  assert.match(text, /Input 1,000 · Output 200 · Cache read 300 · Cache write 50/);
  assert.match(text, /Context · ~1,550 \/ 10,000 tokens · 15\.5% \(estimated\)/);
  assert.match(text, /in progress/);
  assert.ok(repaint > before);
  assert.equal(manager.findAgent(started.agentId).run.state, 'running');
});
