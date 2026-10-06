import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { piRuntime } from './fixtures/subagents/host-runtime.mjs';
import { SubagentManager } from '../packages/subagents/manager.js';
import { createSubagentRuntime } from '../packages/subagents/runtime.js';

async function until(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Live worker condition timed out');
}

test('real Pi worker exposes mid-run tokens, cost, context and a recoverable multiline stream', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagent-live-e2e-'));
  let release;
  let finishStream;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const finalGate = new Promise(resolve => {
    finishStream = resolve;
  });
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const second = payload.messages.some(message => message.role === 'tool');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null, usage) =>
      response.write(
        `data: ${JSON.stringify({
          id: second ? 'second' : 'first',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'live',
          choices: [{ index: 0, delta, finish_reason }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
      );
    if (!second) {
      chunk(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'read-input',
              type: 'function',
              function: {
                name: 'read',
                arguments: JSON.stringify({ path: 'input.txt' }),
              },
            },
          ],
        },
        'tool_calls',
        { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      );
    } else {
      chunk({ role: 'assistant', content: '## Live\n\nfirst chunk' });
      await gate;
      if (response.destroyed) return;
      chunk({ content: '\n\nsecond chunk' }, null, { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 });
      await finalGate;
      if (response.destroyed) return;
      chunk({ content: '\n\n```js\nconst result = 1;\n```' }, 'stop', {
        prompt_tokens: 20,
        completion_tokens: 3,
        total_tokens: 23,
      });
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const providerPath = join(root, 'provider.mjs');
  await writeFile(join(root, 'input.txt'), 'read-only fixture');
  await writeFile(
    providerPath,
    `export default function(pi) {
    pi.registerProvider('live-fixture', {
      api: 'openai-completions', baseUrl: 'http://127.0.0.1:${server.address().port}/v1', apiKey: 'local',
      models: [{ id: 'live', name: 'Live', reasoning: false, input: ['text'],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
    });
  }`,
  );
  const manager = new SubagentManager({
    ownerSessionId: 'live-parent',
    branchId: 'live-branch',
    getConfig: async () => ({ autoDelegate: true, maxConcurrent: 1 }),
    createRuntime: async agent =>
      createSubagentRuntime(
        {
          version: 1,
          piRuntime,
          instanceId: agent.agentId,
          cwd: root,
          agentDir: join(root, 'agent'),
          model: { provider: 'live-fixture', id: 'live' },
          thinkingLevel: 'off',
          allowedTools: ['read'],
          resources: { extensionPaths: [providerPath], skillPaths: [], promptTemplatePaths: [], contextFiles: false },
        },
        { env: { PI_OFFLINE: '1' }, startupTimeoutMs: 8000, requestTimeoutMs: 2000 },
      ),
  });
  t.after(async () => {
    release();
    finishStream();
    await manager.shutdown();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const started = await manager.start({ title: 'Live evidence', task: 'read input and respond' });
  const snapshot = await until(() => {
    const snapshot = manager.activitySnapshot(started.agentId);
    return snapshot.message?.content?.some(block => block.text?.includes('first chunk')) && snapshot;
  });
  assert.match(snapshot.message.content.find(block => block.type === 'text').text, /^## Live\n\nfirst chunk$/);
  const run = await until(() => {
    const run = manager.findAgent(started.agentId).run;
    return run.contextUsage?.tokens > 0 && run.usage?.totalTokens === 12 && run;
  });
  assert.equal(run.state, 'running');
  assert.ok(run.usage.cost.total > 0);
  assert.equal(run.contextUsage.contextWindow, 10000);
  assert.ok(run.contextUsage.percent > 0);
  assert.equal(snapshot.tools.find(tool => tool.toolCallId === 'read-input').finished, true);
  release();
  const continued = await until(() => {
    const snapshot = manager.activitySnapshot(started.agentId);
    return snapshot.message?.content?.some(block => block.text?.includes('second chunk')) && snapshot;
  });
  assert.equal(
    continued.message.content.find(block => block.type === 'text').text,
    '## Live\n\nfirst chunk\n\nsecond chunk',
  );
  assert.equal(
    manager.findAgent(started.agentId).run.state,
    'running',
    'the second fragment is recovered before message_end',
  );
  assert.equal(
    manager.findAgent(started.agentId).run.usage.totalTokens,
    34,
    'previous 12 tokens plus current reported 22, counted once',
  );
  assert.ok(Math.abs(manager.findAgent(started.agentId).run.usage.cost.total - 0.000038) < 1e-12);
  finishStream();
  await manager.wait({ agentIds: [started.agentId], timeoutMs: 8000 });
  const finished = manager.findAgent(started.agentId).run;
  assert.equal(finished.state, 'completed');
  assert.equal(finished.usage.totalTokens, 35, 'both model requests belong to the run');
  assert.ok(Math.abs(finished.usage.cost.total - 0.00004) < 1e-12);
  assert.match(finished.result, /\n\n```js\nconst result = 1;/);
});
