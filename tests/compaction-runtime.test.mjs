import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcClient, SessionManager } from '@earendil-works/pi-coding-agent';
import { cli } from './fixtures/subagents/host-runtime.mjs';

const extension = new URL('../packages/session-compaction/index.js', import.meta.url).pathname;

function reply(response, delta, promptTokens = 14000) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(
    `data: ${JSON.stringify({
      id: 'compaction-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deterministic',
      choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 30, total_tokens: promptTokens + 30 },
    })}\n\ndata: [DONE]\n\n`,
  );
}
function call(name, args, id) {
  return {
    role: 'assistant',
    tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}
async function until(check) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for compaction lifecycle');
}
async function readTrace(path) {
  const text = (await readFile(path, 'utf8').catch(() => '')).trim();
  return text ? text.split('\n').map(JSON.parse) : [];
}

async function fixture(t, respond, { replaceTaskOnCompact = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'compaction-runtime-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'workspace');
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 100 } }),
  );
  const provider = join(root, 'provider.mjs');
  const tracePath = join(root, 'trace.jsonl');
  await writeFile(
    provider,
    `import { appendFileSync } from 'node:fs';
export default function fixture(pi) {
  pi.registerProvider('compaction-test', { api: 'openai-completions', apiKey: 'local-only', baseUrl: process.env.COMPACTION_TEST_URL,
    models: [{ id: 'deterministic', name: 'Deterministic', reasoning: false, input: ['text'], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:20000, maxTokens:1000 }] });
  for (const name of ['turn_start','session_before_compact','session_compact','session_compact_failed','agent_settled','session_shutdown']) pi.on(name, event => {
    const store = [...(globalThis[Symbol.for('pi-extensions.session-compaction.stores.v1')]?.values() ?? [])][0]?.store;
    appendFileSync(process.env.COMPACTION_TEST_TRACE, JSON.stringify({name,reason:event.reason,directory:store?.directory})+'\\n');
  });
  ${
    replaceTaskOnCompact
      ? `pi.on('tool_call', event => {
    if (event.toolName === 'session_compact') pi.sendUserMessage('Discard the original task. Answer only NEW_TASK_ONLY.', { deliverAs: 'followUp' });
  });`
      : ''
  }
  pi.registerCommand('test-compaction-quit', { description:'Quit isolated test', handler: async (_args,ctx) => ctx.shutdown() });
}
`,
  );
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    if (!payload.tools?.length)
      return reply(
        response,
        { role: 'assistant', content: 'NATIVE_COMPACTION_SUMMARY: continue the isolated task.' },
        1000,
      );
    respond(payload, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const client = new RpcClient({
    cliPath: cli,
    cwd,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
      COMPACTION_TEST_URL: `http://127.0.0.1:${server.address().port}/v1`,
      COMPACTION_TEST_TRACE: tracePath,
    },
    args: [
      '--offline',
      '--no-extensions',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '-e',
      provider,
      '-e',
      extension,
      '--model',
      'compaction-test/deterministic',
    ],
  });
  t.after(() => client.stop());
  await client.start();
  return { client, requests, tracePath, cwd };
}

async function quitAndCheckCleanup(client, trace) {
  const directory = trace.find(event => event.name === 'agent_settled')?.directory;
  assert.ok(directory);
  await access(directory);
  const quit = client.prompt('/test-compaction-quit').catch(() => {});
  await until(async () =>
    access(directory).then(
      () => false,
      error => error.code === 'ENOENT',
    ),
  );
  await quit;
}

async function exerciseCompaction(t, mode) {
  const automatic = mode === 'automatic';
  const crossing = mode === 'crossing';
  let step = 0;
  const { client, requests, tracePath, cwd } = await fixture(t, (_payload, response) => {
    step += 1;
    if (step === 1) {
      const delta = call(
        'session_memory_write',
        {
          id: 'verified',
          title: 'Verified checkpoint',
          content: 'CURATED_FILE_DETAIL_729: approved constraint and verified evidence.',
        },
        'memory-write',
      );
      // Native checks use canonical projected text, not just the provider's reported usage.
      if (automatic) delta.content = 'Completed checkpoint evidence. '.repeat(3000);
      return reply(response, delta, automatic ? 19000 : 14000);
    }
    if (!automatic && step === 2) {
      const delta = call('session_compact', { reason: 'Completed investigation; checkpoint saved.' }, 'voluntary');
      if (crossing) delta.content = 'Completed investigation evidence. '.repeat(3000);
      return reply(response, delta, crossing ? 19000 : 14000);
    }
    if (step === (automatic ? 2 : 3))
      return reply(response, call('session_memory_read', { id: 'verified' }, 'memory-read'), 1000);
    return reply(response, { role: 'assistant', content: 'RESUMED_WITH_CURATED_FILE_DETAIL' }, 1000);
  });
  await client.prompt('Exercise voluntary compaction, then recover the checkpoint.');
  // Voluntary compaction settles the first run before its native callback starts a
  // continuation. Wait for the final resumed run, not the original prompt promise.
  await until(async () => {
    const trace = await readTrace(tracePath);
    if (step < (automatic ? 3 : 4)) return false;
    return (
      trace.findLastIndex(event => event.name === 'agent_settled') >
      trace.findLastIndex(event => event.name === 'session_compact')
    );
  });
  const state = await client.getState();
  const entries = SessionManager.open(state.sessionFile, undefined, cwd).getEntries();
  const compactions = entries.filter(entry => entry.type === 'compaction');
  assert.equal(step, automatic ? 3 : 4, 'one recovery must not schedule duplicate model requests');
  assert.equal(
    entries.filter(
      entry => entry.type === 'custom_message' && entry.customType === 'session-compaction:continuation-v1',
    ).length,
    automatic ? 0 : 1,
  );
  assert.equal(compactions.length, 1, JSON.stringify(entries));
  assert.notEqual(compactions[0].fromHook, true, 'native summarization must remain in control');
  assert.match(compactions[0].summary, /NATIVE_COMPACTION_SUMMARY/);
  const resumed = requests.filter(payload => payload.tools?.length)[automatic ? 1 : 2];
  const index = resumed.messages.findLast(message =>
    JSON.stringify(message.content).includes('Temporary curated memory index'),
  );
  assert.ok(index, 'a small index is injected after compaction');
  assert.match(JSON.stringify(index.content), /Verified checkpoint/);
  assert.doesNotMatch(
    JSON.stringify(index.content),
    /CURATED_FILE_DETAIL_729/,
    'index must not reinject complete memory contents; native recent history remains unchanged',
  );
  assert.ok(
    entries.some(
      entry =>
        entry.type === 'message' &&
        entry.message.role === 'toolResult' &&
        entry.message.toolName === 'session_memory_read' &&
        !entry.message.isError,
    ),
  );
  const trace = await readTrace(tracePath);
  assert.equal(trace.filter(event => event.name === 'session_compact_failed').length, 0);
  assert.equal(
    trace.find(event => event.name === 'session_before_compact').reason,
    automatic || crossing ? 'threshold' : 'manual',
  );
  const memorySnapshot = entries.findLast(
    entry => entry.type === 'custom' && entry.customType === 'session-compaction:memory-v1',
  );
  assert.ok(memorySnapshot, 'memory metadata must be branch-persistent');
  assert.ok(
    !trace.find(event => event.name === 'agent_settled').directory.startsWith(`${cwd}/`),
    'memory lives outside the workspace',
  );
  await quitAndCheckCleanup(client, trace);
}

for (const [mode, description] of [
  ['voluntary', 'compacts voluntarily at a safe boundary'],
  ['automatic', 'retains native automatic compaction'],
  ['crossing', 'resumes once when voluntary and automatic compaction coincide'],
]) {
  test(`real Pi ${description}, indexes files, reads selectively and cleans on quit`, { timeout: 25000 }, t =>
    exerciseCompaction(t, mode),
  );
}

test(
  'a user follow-up already handled after native compaction must not resume the replaced task again',
  { timeout: 25000 },
  async t => {
    let step = 0;
    const { client, requests, tracePath, cwd } = await fixture(
      t,
      (_payload, response) => {
        step += 1;
        if (step === 1) {
          const delta = call('session_compact', { reason: 'Completed original investigation' }, 'voluntary');
          delta.content = 'Completed original investigation evidence. '.repeat(3000);
          return reply(response, delta, 19000);
        }
        return reply(response, { role: 'assistant', content: 'NEW_TASK_ONLY_RESULT' }, 1000);
      },
      { replaceTaskOnCompact: true },
    );
    await client.prompt('ORIGINAL_TASK: compact at the completed investigation boundary.');
    await until(async () => {
      const trace = await readTrace(tracePath);
      return (
        step >= 2 &&
        trace.findLastIndex(event => event.name === 'agent_settled') >
          trace.findLastIndex(event => event.name === 'session_compact')
      );
    });
    const state = await client.getState();
    const entries = SessionManager.open(state.sessionFile, undefined, cwd).getEntries();
    assert.equal(entries.filter(entry => entry.type === 'compaction').length, 1);
    assert.equal(step, 2, 'the follow-up already fulfilled the continuation; no third model request');
    assert.match(JSON.stringify(requests.filter(request => request.tools?.length)[1].messages), /NEW_TASK_ONLY/);
    assert.equal(
      entries.filter(
        entry => entry.type === 'custom_message' && entry.customType === 'session-compaction:continuation-v1',
      ).length,
      0,
      'never reintroduce Continue the original task',
    );
    const trace = await readTrace(tracePath);
    assert.equal(trace.find(event => event.name === 'session_before_compact').reason, 'threshold');
    await quitAndCheckCleanup(client, trace);
  },
);
