import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { JsonlDecoder, MAX_RECORD_BYTES, createRpcConnection } from '../packages/subagents/protocol.js';
import { resolveTrackedProcessSnapshot } from '../packages/subagents/process-cleanup.js';
import { createSubagentRuntime } from '../packages/subagents/runtime.js';
import { PS_ARGS, PS_COMMAND, PS_ENV, parseProcessRows } from '../packages/shared/process-tree.js';
import { piRuntime } from './fixtures/subagents/host-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Process-group cleanup is verified on these platforms only; elsewhere startup refuses before spawning.
const processCleanupVerified = ['darwin', 'linux'].includes(process.platform);
const fakeWorker = join(here, 'fixtures/subagents/fake-rpc.mjs');
const psRows = () => parseProcessRows(execFileSync(PS_COMMAND, PS_ARGS, { encoding: 'utf8', env: PS_ENV }));
const baseBootstrap = () => ({
  version: 1,
  piRuntime,
  instanceId: `instance-${Date.now()}-${Math.random()}`,
  parentSessionId: 'parent-test',
  cwd: process.cwd(),
  agentDir: process.cwd(),
  model: { provider: 'test', id: 'deterministic' },
  thinkingLevel: 'off',
  allowedTools: [],
  resources: { extensionPaths: [], skillPaths: [], promptTemplatePaths: [], contextFiles: false },
});

// A dedicated RPC boundary double keeps the shared lifecycle fixtures unchanged.
async function telemetryRuntime(t, configuration = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'subagent-telemetry-'));
  const workerPath = join(directory, 'worker.mjs');
  const commandFile = join(directory, 'commands');
  await writeFile(
    workerPath,
    `
    import { appendFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    let bootstrap, active = false, turn = 0, archived = 0, compacted = false;
    const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
    const reply = (command, data, error) => emit({ id: command.id, type: 'response', command: command.type, success: !error, data, error });
    process.on('message', message => {
      bootstrap = message.bootstrap;
      process.send({ type: 'subagent-ready', instanceId: bootstrap.instanceId, piRuntime: bootstrap.piRuntime });
    });
    createInterface({ input: process.stdin }).on('line', line => {
      const command = JSON.parse(line);
      appendFileSync(bootstrap.commandFile, command.type + '\\n');
      if (command.type === 'get_state') return reply(command, { sessionId: bootstrap.instanceId, isStreaming: active, pendingMessageCount: 0, model: bootstrap.model, thinkingLevel: bootstrap.thinkingLevel });
      if (command.type === 'get_session_stats') {
        const snapshot = () => ({ assistantMessages: 10 + archived, tokens: { input: 100 + archived * 20, output: 30 + archived * 4, cacheRead: 10 + archived * 2, cacheWrite: 5 + archived, total: 145 + archived * 27 }, cost: 1 + archived * 0.25, contextUsage: compacted ? { tokens: null, contextWindow: 1000, percent: null } : { tokens: 200 + archived, contextWindow: 1000, percent: (200 + archived) / 10 } });
        const data = snapshot();
        const unavailable = bootstrap.statsUnavailable || (bootstrap.statsFailAtEnd && turn > 0 && archived === turn * 2);
        return setTimeout(() => reply(command, bootstrap.statsAtReply ? snapshot() : data, unavailable ? 'stats unavailable' : undefined), bootstrap.statsDelayMs ?? 0);
      }
      if (command.type === 'prompt') {
        active = true;
        turn++;
        reply(command);
        emit({ type: 'agent_start' });
        const finishMessage = index => {
          for (let i = 0; i < 50; i++) emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } });
          const usage = (index === 2 && bootstrap.secondAssistantUsage) || { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { total: 0.125 } };
          emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'turn=' + turn + ';message=' + index }], stopReason: 'stop', usage } });
          emit({ type: 'tool_execution_end', toolCallId: 'tool-' + index });
          emit({ type: 'compaction_end', reason: 'threshold', result: {}, aborted: false, willRetry: false });
          // Session persistence follows message_end, just as it does in the SDK.
          archived++;
          emit({ type: 'agent_end', messages: [] });
        };
        setTimeout(() => {
          finishMessage(1);
          if (!bootstrap.compactionReason) setTimeout(() => { finishMessage(2); active = false; emit({ type: 'agent_settled' }); }, 30);
        }, 30);
        return;
      }
      if (command.type === 'steer' && bootstrap.compactionReason) {
        reply(command);
        emit({ type: 'compaction_start', reason: bootstrap.compactionReason });
        compacted = true;
        emit({ type: 'compaction_end', reason: bootstrap.compactionReason, result: {}, aborted: false, willRetry: false });
        return;
      }
      if (command.type === 'clear_queue' || command.type === 'abort') return reply(command);
      reply(command, undefined, 'unsupported command');
    }).on('close', () => process.exit(0));
    process.on('disconnect', () => process.exit(0));
  `,
  );
  const runtime = createSubagentRuntime(
    { ...baseBootstrap(), ...configuration, commandFile },
    { workerPath, startupTimeoutMs: 2_000, requestTimeoutMs: 1_000 },
  );
  t.after(async () => {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await runtime.start();
  return { runtime, commands: async () => (await readFile(commandFile, 'utf8')).trim().split('\n') };
}

const expectedRunUsage = { input: 40, output: 8, cacheRead: 4, cacheWrite: 2, totalTokens: 54, cost: { total: 0.5 } };

test('runtime telemetry confirms multi-turn run usage against a pre-prompt session baseline', async t => {
  const { runtime, commands } = await telemetryRuntime(t);
  const events = [];
  runtime.subscribe(event => events.push(event));
  const first = await runtime.prompt('two messages');
  const result = await first.result;
  assert.deepEqual(result.usage, expectedRunUsage);
  assert.deepEqual(result.contextUsage, { tokens: 202, contextWindow: 1000, percent: 20.2 });
  const telemetry = events.filter(event => event.type === 'telemetry');
  assert.ok(telemetry.length >= 3, 'baseline, live message boundary and final telemetry');
  assert.ok(telemetry.every(event => event.runId === first.runId && Number.isFinite(event.data.updatedAt)));
  assert.deepEqual(telemetry[0].data.usage, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { total: 0 },
  });
  assert.deepEqual(telemetry.at(-1).data.usage, expectedRunUsage);
  assert.deepEqual(telemetry.at(-1).data.sessionUsage, {
    input: 140,
    output: 38,
    cacheRead: 14,
    cacheWrite: 7,
    totalTokens: 199,
    cost: { total: 1.5 },
  });
  assert.ok(
    events.findIndex(event => event.type === 'telemetry') < events.findIndex(event => event.type === 'accepted'),
  );
  const sent = await commands();
  assert.ok(sent.indexOf('get_session_stats') < sent.indexOf('prompt'));
  assert.ok(
    sent.filter(command => command === 'get_session_stats').length <= 5,
    'bursts and 100 deltas do not poll stats per event',
  );
  const second = await runtime.prompt('continuation');
  assert.deepEqual((await second.result).usage, expectedRunUsage, 'the next run excludes all prior session usage');
});

for (const reason of ['manual', 'threshold', 'overflow'])
  test(`native ${reason} compaction refreshes context without another message or tool boundary`, async t => {
    const { runtime } = await telemetryRuntime(t, { compactionReason: reason });
    let latest;
    let resolveInitial;
    let resolveCompacted;
    const initial = new Promise(resolve => {
      resolveInitial = resolve;
    });
    const compacted = new Promise(resolve => {
      resolveCompacted = resolve;
    });
    const waitForSample = async promise => {
      let timer;
      try {
        await Promise.race([
          promise,
          new Promise(resolve => {
            timer = setTimeout(resolve, 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    runtime.subscribe(event => {
      if (event.type !== 'telemetry') return;
      latest = event.data;
      if (latest.contextUsage?.tokens === 201) resolveInitial();
      if (latest.contextUsage?.tokens === null) resolveCompacted();
    });
    await runtime.prompt('pause after first assistant, then compact');
    await waitForSample(initial);
    assert.equal(
      latest?.contextUsage?.tokens,
      201,
      'the pre-compaction sample must arrive before triggering compaction',
    );
    assert.equal(latest.usage.totalTokens, 27);
    await runtime.steer('trigger fixture compaction');
    await waitForSample(compacted);
    assert.deepEqual(
      latest.contextUsage,
      { tokens: null, contextWindow: 1000, percent: null },
      'compaction invalidates the old 201-token context estimate',
    );
    assert.equal(latest.usage.totalTokens, 27, 'context invalidation must preserve confirmed billed usage');
    assert.equal(runtime.status, 'running', 'no later assistant or settling boundary provides the refresh');
  });

test('telemetry RPC errors are non-fatal and fallback sums every assistant message', async t => {
  const { runtime } = await telemetryRuntime(t, { statsUnavailable: true });
  const events = [];
  runtime.subscribe(event => events.push(event));
  const first = await runtime.prompt('stats unavailable');
  const result = await first.result;
  const fallback = { input: 6, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 12, cost: { total: 0.25 } };
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.usage, fallback);
  assert.match(result.sessionStats.error, /stats unavailable/);
  assert.deepEqual(events.filter(event => event.type === 'telemetry').at(-1).data.usage, fallback);
  assert.equal(
    events.some(event => event.type === 'error'),
    false,
  );
  assert.equal(runtime.status, 'idle');
  const next = await runtime.prompt('retry stats');
  assert.deepEqual((await next.result).usage, fallback);
});

test('a final stats error preserves the last confirmed paid usage and session snapshot', async t => {
  const { runtime } = await telemetryRuntime(t, {
    statsFailAtEnd: true,
    secondAssistantUsage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { total: 0.01 } },
  });
  const samples = [];
  runtime.subscribe(event => {
    if (event.type === 'telemetry') samples.push(event.data);
  });
  const run = await runtime.prompt('retain paid compaction and tools');
  const result = await run.result;
  const confirmed = { input: 23, output: 6, cacheRead: 3, cacheWrite: 1, totalTokens: 33, cost: { total: 0.26 } };
  assert.deepEqual(
    result.usage,
    confirmed,
    'the confirmed first 27 tokens plus the subsequent 6-token assistant message must both survive',
  );
  assert.equal(samples[0].usage.totalTokens, 0);
  const confirmedSamples = samples.slice(1);
  assert.ok(confirmedSamples.length >= 2);
  assert.ok(
    confirmedSamples.every(sample => sample.usage.totalTokens >= 27),
    'later failed reads must never reduce confirmed usage',
  );
  assert.equal(confirmedSamples.at(-1).usage.totalTokens, 33);
  assert.deepEqual(samples.at(-1).sessionUsage, samples[1].sessionUsage);
  assert.deepEqual(result.sessionStats, {
    assistantMessages: 11,
    tokens: { input: 120, output: 34, cacheRead: 12, cacheWrite: 6, total: 172 },
    cost: 1.25,
    contextUsage: { tokens: 201, contextWindow: 1000, percent: 20.1 },
  });
  assert.deepEqual(result.contextUsage, result.sessionStats.contextUsage);
  assert.equal(result.status, 'completed');
});

test('a final stats error adds later assistant consumption once to the confirmed extra usage', async t => {
  const { runtime } = await telemetryRuntime(t, {
    statsFailAtEnd: true,
    secondAssistantUsage: { input: 30, output: 10, cacheRead: 4, cacheWrite: 2, totalTokens: 46, cost: { total: 0.5 } },
  });
  const run = await runtime.prompt('assistant fallback progresses');
  const result = await run.result;
  assert.deepEqual(
    result.usage,
    { input: 50, output: 14, cacheRead: 6, cacheWrite: 3, totalTokens: 73, cost: { total: 0.75 } },
    'the sampled 27 includes the first 6-token assistant message: add only the next 46 tokens',
  );
  assert.equal(
    result.sessionStats.tokens.total,
    172,
    'retain the last successful snapshot independently of fallback progress',
  );
  assert.equal(result.contextUsage.tokens, 201);
});

test('a delayed snapshot followed by a final stats failure retains later assistant consumption', async t => {
  const { runtime } = await telemetryRuntime(t, {
    statsDelayMs: 80,
    statsFailAtEnd: true,
    secondAssistantUsage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { total: 0.01 } },
  });
  const run = await runtime.prompt('snapshot predates the second message');
  const result = await run.result;
  assert.deepEqual(
    result.usage,
    { input: 23, output: 6, cacheRead: 3, cacheWrite: 1, totalTokens: 33, cost: { total: 0.26 } },
    'a delayed 27-token snapshot includes only the first assistant: add the second 6 tokens exactly once',
  );
  assert.equal(result.sessionStats.assistantMessages, 11);
  assert.equal(result.status, 'completed');
});

test('a snapshot including assistants completed in flight does not count them twice', async t => {
  const { runtime } = await telemetryRuntime(t, { statsDelayMs: 80, statsAtReply: true });
  const samples = [];
  runtime.subscribe(event => {
    if (event.type === 'telemetry') samples.push(event.data);
  });
  const run = await runtime.prompt('newer snapshot includes both messages');
  assert.deepEqual((await run.result).usage, expectedRunUsage);
  assert.ok(
    samples.every(sample => sample.usage.totalTokens <= 54),
    'do not add a second assistant already present in the snapshot',
  );
  assert.equal(samples.at(-1).usage.totalTokens, 54);
});

test('settle drains an in-flight telemetry snapshot before the next run', async t => {
  const { runtime, commands } = await telemetryRuntime(t, { statsDelayMs: 80 });
  const events = [];
  runtime.subscribe(event => events.push(event));
  const first = await runtime.prompt('slow snapshot');
  assert.equal(runtime.status, 'running');
  assert.deepEqual(
    (await first.result).usage,
    expectedRunUsage,
    'a pre-final snapshot must not undercount the final turn',
  );
  const second = await runtime.prompt('next slow snapshot');
  const firstEventCount = events.filter(event => event.type === 'telemetry' && event.runId === first.runId).length;
  assert.deepEqual((await second.result).usage, expectedRunUsage);
  assert.equal(
    events.filter(event => event.type === 'telemetry' && event.runId === first.runId).length,
    firstEventCount,
    'no late snapshot from the first run',
  );
  assert.ok((await commands()).filter(command => command === 'get_session_stats').length <= 8);
});

test('stop during the baseline read does not dispatch a prompt or publish late telemetry', async t => {
  const { runtime, commands } = await telemetryRuntime(t, { statsDelayMs: 150 });
  const events = [];
  runtime.subscribe(event => events.push(event));
  const prompting = runtime.prompt('must never run');
  const rejection = assert.rejects(prompting, /stopped|closed|ended/);
  await new Promise(resolve => setTimeout(resolve, 20));
  await runtime.stop();
  await rejection;
  assert.equal((await commands()).includes('prompt'), false);
  assert.equal(
    events.some(event => event.type === 'telemetry' || event.type === 'accepted'),
    false,
  );
  assert.equal(runtime.status, 'stopped');
});

test('runtime requires an explicit host descriptor instead of a local SDK fallback', () => {
  assert.throws(() => createSubagentRuntime({ ...baseBootstrap(), piRuntime: undefined }), /descriptor/);
});

test('startup rejects contradictory runtime, model, reasoning and RPC state before any prompt', async t => {
  for (const contradiction of [
    { fakeReadyRuntime: { ...piRuntime, entry: `${piRuntime.entry}.other` } },
    { fakeReadyRuntime: { ...piRuntime, version: 'other' } },
    { fakeReadyRuntime: { ...piRuntime, fingerprint: '0'.repeat(64) } },
    { fakeState: { sessionId: 'other' } },
    { fakeState: { model: { provider: 'other', id: 'other' } } },
    { fakeState: { thinkingLevel: 'high' } },
    { fakeState: { isStreaming: true } },
    { fakeState: { pendingMessageCount: 1 } },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'startup-contradiction-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const commands = join(directory, 'commands');
    const runtime = createSubagentRuntime(
      { ...baseBootstrap(), ...contradiction, fakeCommandFile: commands },
      { workerPath: fakeWorker },
    );
    t.after(() => runtime.stop());
    await assert.rejects(runtime.start(), /mismatch|does not match|not idle/);
    assert.equal(runtime.status, 'stopped');
    const sent = await readFile(commands, 'utf8').catch(() => '');
    assert.ok(!sent.split('\n').includes('prompt'));
  }
});

test('strict JSONL preserves split UTF-8, Unicode separators, CRLF and final records', () => {
  const records = [];
  const decoder = new JsonlDecoder(value => records.push(value));
  const bytes = Buffer.from('{"text":"é\u2028x\u2029"}\r\n{"final":true}', 'utf8');
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  decoder.write(bytes.subarray(0, split));
  decoder.write(bytes.subarray(split));
  decoder.end();
  assert.deepEqual(records, [{ text: 'é\u2028x\u2029' }, { final: true }]);
});

test('strict JSONL rejects malformed and oversized records without truncation', () => {
  assert.throws(() => new JsonlDecoder(() => {}).write('{bad}\n'), /invalid JSON/i);
  const decoder = new JsonlDecoder(() => {}, { maxRecordBytes: 8 });
  assert.throws(() => decoder.write('123456789'), /exceeds 8 bytes/i);
  assert.equal(MAX_RECORD_BYTES, 32 * 1024 * 1024);
});

test('RPC correlates reversed responses and interleaved events', async () => {
  const readable = new PassThrough();
  let input = '';
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk;
      callback();
    },
  });
  const rpc = createRpcConnection({ readable, writable, requestTimeoutMs: 500 });
  const events = [];
  rpc.subscribe(event => events.push(event));
  const first = rpc.request('first');
  const second = rpc.request('second');
  await new Promise(resolve => setImmediate(resolve));
  const [a, b] = input.trim().split('\n').map(JSON.parse);
  assert.notEqual(a.id, b.id);
  readable.write(`${JSON.stringify({ type: 'progress', value: 1 })}\n`);
  readable.write(`${JSON.stringify({ id: b.id, type: 'response', command: 'second', success: true, data: 2 })}\n`);
  readable.write(`${JSON.stringify({ id: a.id, type: 'response', command: 'first', success: true, data: 1 })}\n`);
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.deepEqual(events, [{ type: 'progress', value: 1 }]);
  rpc.close();
});

test('RPC serializes writes under backpressure', async () => {
  const readable = new PassThrough();
  const writes = [];
  const callbacks = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(String(chunk));
      callbacks.push(callback);
    },
  });
  const rpc = createRpcConnection({ readable, writable, requestTimeoutMs: 500 });
  const first = rpc.request('first');
  const second = rpc.request('second');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1);
  callbacks.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 2);
  const commands = writes.map(JSON.parse);
  callbacks.shift()();
  readable.write(`${JSON.stringify({ id: commands[0].id, type: 'response', command: 'first', success: true })}\n`);
  readable.write(`${JSON.stringify({ id: commands[1].id, type: 'response', command: 'second', success: true })}\n`);
  await Promise.all([first, second]);
  rpc.close();
});

test('tracked cleanup rejects a reused PID with a different birth identity', () => {
  const tracked = [{ pid: 42, pgid: 42, start: 'Mon Jan  1 00:00:00 2024', detached: true }];
  const reused = [{ pid: 42, ppid: 1, pgid: 42, start: 'Tue Jan  2 00:00:00 2024' }];
  assert.deepEqual([...resolveTrackedProcessSnapshot(tracked, reused, 7).groups], []);

  const originalLeader = [{ pid: 42, ppid: 1, pgid: 42, start: 'Mon Jan  1 00:00:00 2024' }];
  assert.deepEqual([...resolveTrackedProcessSnapshot(tracked, originalLeader, 7).groups], [42]);

  const survivingOriginalMember = [{ pid: 43, ppid: 1, pgid: 42, start: 'Mon Jan  1 00:00:01 2024' }];
  assert.deepEqual([...resolveTrackedProcessSnapshot(tracked, survivingOriginalMember, 7).groups], [42]);
});

test('RPC closes after a correlated response names the wrong command', async () => {
  const readable = new PassThrough();
  let input = '';
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk;
      callback();
    },
  });
  const rpc = createRpcConnection({ readable, writable, requestTimeoutMs: 500 });
  const request = rpc.request('prompt', { message: 'uncertain' });
  await new Promise(resolve => setImmediate(resolve));
  const command = JSON.parse(input);
  readable.write(`${JSON.stringify({ id: command.id, type: 'response', command: 'steer', success: true })}\n`);
  await assert.rejects(request, /command mismatch/i);
  assert.equal(rpc.closed, true);
  await assert.rejects(rpc.request('prompt', { message: 'retry' }), /closed/i);
});

test('RPC never dispatches a queued command after its acknowledgement timeout', async () => {
  const readable = new PassThrough();
  const writes = [];
  const callbacks = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(String(chunk));
      callbacks.push(callback);
    },
  });
  const rpc = createRpcConnection({ readable, writable, requestTimeoutMs: 25 });
  const blocker = rpc.request('blocker').catch(error => error);
  const timedOut = rpc.request('prompt', { message: 'must not run' });
  await assert.rejects(timedOut, /timed out/i);
  callbacks.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1);
  assert.match((await blocker).message, /timed out|closed/i);
  rpc.close();
});

test('RPC refuses a bounded write queue overflow rather than truncating JSON', async () => {
  const readable = new PassThrough();
  const writable = new Writable({ write(_chunk, _encoding, _callback) {} });
  const rpc = createRpcConnection({ readable, writable, requestTimeoutMs: 500, maxWriteQueueBytes: 1 });
  await assert.rejects(rpc.request('large', { payload: 'data' }), /write queue exceeds 1 bytes/i);
  rpc.close();
});

test('runtime returns on acceptance, settles only on agent_settled and reuses one child', async t => {
  const runtime = createSubagentRuntime(
    { ...baseBootstrap(), fakeMessageDelayMs: 40 },
    { workerPath: fakeWorker, startupTimeoutMs: 2_000, requestTimeoutMs: 1_000 },
  );
  t.after(() => runtime.stop());
  await runtime.start();
  const events = [];
  runtime.subscribe(event => events.push(event));
  const first = await runtime.prompt('/must-not-expand');
  assert.equal(runtime.status, 'running');
  let settled = false;
  first.result.finally(() => {
    settled = true;
  });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(settled, false, 'agent_end must not settle the run');
  await runtime.steer('/extra');
  const firstResult = await first.result;
  assert.equal(firstResult.status, 'completed');
  assert.match(firstResult.text, /Delegated mission/);
  assert.match(firstResult.text, /Additional instruction/);
  assert.equal(firstResult.sessionStats.tokens.total, 12);

  const second = await runtime.prompt('follow-up');
  const secondResult = await second.result;
  const firstPid = firstResult.text.match(/pid=(\d+)/)[1];
  assert.equal(secondResult.text.match(/pid=(\d+)/)[1], firstPid);
  assert.match(secondResult.text, /turn=2/);
  assert.notEqual(first.runId, second.runId);
  assert.ok(
    events.every(
      (event, index) =>
        event.instanceId === runtime.instanceId && (index === 0 || event.sequence === events[index - 1].sequence + 1),
    ),
  );
});

test('an incoherent prompt acknowledgement closes the runtime instead of allowing a retry', async t => {
  const runtime = createSubagentRuntime(
    { ...baseBootstrap(), fakeWrongPromptCommandOnce: true },
    { workerPath: fakeWorker, startupTimeoutMs: 2_000, requestTimeoutMs: 500 },
  );
  t.after(() => runtime.stop());
  await runtime.start();
  await assert.rejects(runtime.prompt('uncertain acknowledgement'), /command mismatch/i);
  assert.notEqual(runtime.status, 'idle');
  await assert.rejects(runtime.prompt('duplicate retry'), /stopped|not idle/i);
});

test('an uncertain prompt timeout closes the runtime instead of allowing a duplicate retry', async t => {
  const runtime = createSubagentRuntime(
    { ...baseBootstrap(), fakeIgnorePromptResponse: true },
    { workerPath: fakeWorker, startupTimeoutMs: 2_000, requestTimeoutMs: 25 },
  );
  t.after(() => runtime.stop());
  await runtime.start();
  await assert.rejects(runtime.prompt('uncertain delivery'), /timed out/i);
  assert.notEqual(runtime.status, 'idle');
  await assert.rejects(runtime.prompt('duplicate retry'), /stopped|not idle/i);
});

test('a rejected prompt leaves the instance reusable for a retry', async t => {
  const runtime = createSubagentRuntime(
    { ...baseBootstrap(), fakeRejectPromptOnce: true },
    { workerPath: fakeWorker, startupTimeoutMs: 2_000 },
  );
  t.after(() => runtime.stop());
  await runtime.start();
  await assert.rejects(runtime.prompt('rejected'), /simulated rejection/);
  assert.equal(runtime.status, 'idle');
  const retry = await runtime.prompt('retry');
  assert.equal((await retry.result).status, 'completed');
});

test('steering is rejected after agent_settled while final statistics are collected', async t => {
  const runtime = createSubagentRuntime(
    { ...baseBootstrap(), fakeStatsDelayMs: 100 },
    { workerPath: fakeWorker, startupTimeoutMs: 2_000 },
  );
  t.after(() => runtime.stop());
  await runtime.start();
  let lateSteer;
  const settledEvent = new Promise(resolve => {
    const unsubscribe = runtime.subscribe(event => {
      if (event.type === 'rpc_event' && event.data?.type === 'agent_settled') {
        lateSteer = runtime.steer('too late');
        unsubscribe();
        resolve();
      }
    });
  });
  const run = await runtime.prompt('settling');
  await settledEvent;
  await assert.rejects(lateSteer, /no active run/i);
  assert.equal((await run.result).status, 'completed');
  const next = await runtime.prompt('next run');
  assert.equal((await next.result).status, 'completed');
});

test('a throwing settled subscriber cannot prevent result resolution', async t => {
  const runtime = createSubagentRuntime(baseBootstrap(), { workerPath: fakeWorker, startupTimeoutMs: 2_000 });
  t.after(() => runtime.stop());
  await runtime.start();
  runtime.subscribe(event => {
    if (event.type === 'settled') throw new Error('subscriber failure');
  });
  const run = await runtime.prompt('subscriber isolation');
  const result = await Promise.race([
    run.result,
    new Promise((_, reject) => setTimeout(() => reject(new Error('result remained pending')), 500)),
  ]);
  assert.equal(result.status, 'completed');
  assert.equal(runtime.status, 'idle');
});

test(
  'spawn failure rejects startup without an unhandled child-process error',
  { skip: !processCleanupVerified },
  async () => {
    const missingCwd = join(tmpdir(), `missing-subagent-cwd-${randomUUID()}`);
    const runtime = createSubagentRuntime(
      { ...baseBootstrap(), cwd: missingCwd },
      { startupTimeoutMs: 500, requestTimeoutMs: 100 },
    );
    await assert.rejects(runtime.start(), /ENOENT|spawn|process failed|startup/i);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(runtime.status, /failed|stopped/);
    await runtime.stop();
  },
);

/** Kills a worker that startup should have refused, so a regression cannot hang the suite. */
function killStrayWorker(runtime) {
  if (!runtime.pid) return;
  try {
    process.kill(-runtime.pid, 'SIGKILL');
  } catch {}
}

test('startup refuses a platform without verified process cleanup before spawning a worker', async t => {
  for (const platform of ['freebsd', 'win32']) {
    const runtime = createSubagentRuntime(baseBootstrap(), {
      workerPath: fakeWorker,
      startupTimeoutMs: 2_000,
      platform,
    });
    t.after(() => killStrayWorker(runtime));
    await assert.rejects(runtime.start(), new RegExp(`not verified on ${platform}.*macOS and Linux`));
    assert.equal(runtime.status, 'failed');
    assert.equal(runtime.pid, undefined, 'no worker may run without a verified way to stop it');
  }
});

test('startup explains how to provide ps before spawning a worker it could not stop', async t => {
  const runtime = createSubagentRuntime(baseBootstrap(), {
    workerPath: fakeWorker,
    startupTimeoutMs: 2_000,
    processSnapshot: () => {
      throw new Error('Process observation failed: spawn /bin/ps ENOENT');
    },
  });
  t.after(() => killStrayWorker(runtime));
  await assert.rejects(runtime.start(), error => {
    assert.match(error.message, /\/bin\/ps/);
    assert.match(error.message, /procps/, 'names the Linux package that provides a compatible ps');
    assert.match(error.message, /ENOENT/, 'keeps the underlying observation failure');
    return true;
  });
  assert.equal(runtime.status, 'failed');
  assert.equal(runtime.pid, undefined, 'no worker may run without a verified way to stop it');
});

/** Stops the runtime while its cleanup check is pending, then lets the check settle with `outcome`. */
async function stopDuringCleanupCheck(t, outcome) {
  let markChecking;
  let releaseCheck;
  const checking = new Promise(resolve => {
    markChecking = resolve;
  });
  const checkGate = new Promise(resolve => {
    releaseCheck = resolve;
  });
  const runtime = createSubagentRuntime(baseBootstrap(), {
    workerPath: fakeWorker,
    startupTimeoutMs: 2_000,
    processSnapshot: async () => {
      markChecking();
      await checkGate;
      return outcome();
    },
  });
  t.after(() => killStrayWorker(runtime));
  const starting = runtime.start();
  await checking;
  await runtime.stop();
  releaseCheck();
  return { runtime, starting };
}

test(
  'stop during the process cleanup check prevents the worker from spawning',
  { skip: !processCleanupVerified },
  async t => {
    const { runtime, starting } = await stopDuringCleanupCheck(t, psRows);
    await assert.rejects(starting, /startup was stopped/);
    assert.equal(runtime.pid, undefined, 'a stopped runtime must not leave a worker behind');
    assert.equal(runtime.status, 'stopped');
  },
);

test('a cleanup check failing after stop leaves the runtime stopped', async t => {
  const { runtime, starting } = await stopDuringCleanupCheck(t, () => {
    throw new Error('Process observation failed: spawn /bin/ps ENOENT');
  });
  await assert.rejects(starting, /\/bin\/ps/);
  assert.equal(runtime.status, 'stopped', 'a completed stop is final');
  await runtime.stop();
  assert.equal(runtime.status, 'stopped');
  assert.equal(runtime.pid, undefined);
});

test('cleanup can be retried after process observation recovers', { skip: !processCleanupVerified }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subagent-ps-recovery-'));
  const pidFile = join(directory, 'pids.json');
  let pids = [];
  let observationFails = false;
  const readSnapshot = () => {
    if (observationFails) throw new Error('injected ps failure');
    return psRows();
  };
  const runtime = createSubagentRuntime(
    {
      ...baseBootstrap(),
      fakeIgnoreEof: true,
      fakeIgnoreSigterm: true,
      fakeDescendants: true,
      fakePidFile: pidFile,
    },
    { workerPath: fakeWorker, startupTimeoutMs: 2_000, processSnapshot: readSnapshot },
  );
  t.after(async () => {
    for (const pid of pids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  });
  await runtime.start();
  pids = JSON.parse(await readFile(pidFile, 'utf8'));
  const exists = pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  observationFails = true;
  await assert.rejects(runtime.stop(), /injected ps failure/);
  const workerDeadline = Date.now() + 1_000;
  while (exists(pids[0]) && Date.now() < workerDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(pids.map(exists), [false, true, true]);
  assert.equal(runtime.status, 'failed');

  observationFails = false;
  await runtime.stop();
  assert.equal(runtime.status, 'stopped');
  assert.deepEqual(pids.map(exists), [false, false, false]);
});

test(
  'a cleanup deadline keeps the process registry until a successful retry',
  { skip: !processCleanupVerified },
  async t => {
    const readSnapshot = psRows;
    const directory = await mkdtemp(join(tmpdir(), 'subagent-deadline-'));
    const pidFile = join(directory, 'pids.json');
    let stale;
    const runtime = createSubagentRuntime(
      { ...baseBootstrap(), fakeIgnoreEof: true, fakeDescendants: true, fakePidFile: pidFile },
      {
        workerPath: fakeWorker,
        startupTimeoutMs: 2_000,
        processSnapshot: () => stale ?? readSnapshot(),
      },
    );
    t.after(async () => {
      stale = undefined;
      await runtime.stop().catch(() => {});
      try {
        for (const pid of JSON.parse(await readFile(pidFile, 'utf8'))) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {}
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
      } catch {}
      await rm(directory, { recursive: true, force: true });
    });
    await runtime.start();
    const childPid = JSON.parse(await readFile(pidFile, 'utf8'))[1];
    const registries = (await readdir(tmpdir())).filter(name => /^pi-subagent-.*\.pids$/u.test(name));
    const matching = [];
    for (const name of registries) {
      const path = join(tmpdir(), name);
      try {
        if ((await readFile(path, 'utf8')).includes(`"pid":${childPid},`)) matching.push(path);
      } catch {}
    }
    assert.equal(matching.length, 1);
    const trackFile = matching[0];
    stale = readSnapshot();
    assert.ok(stale.some(row => row.pid === runtime.pid));
    await assert.rejects(runtime.stop(), /cleanup deadline/);
    assert.equal(runtime.status, 'failed');
    assert.ok((await stat(trackFile)).isFile());
    stale = undefined;
    await runtime.stop();
    await assert.rejects(stat(trackFile), { code: 'ENOENT' });
  },
);

/** PID of a process alone in its group, exited and unreaped: macOS rejects killpg on that group with EPERM. */
async function zombieGroup(t) {
  const holder = spawn(
    'perl',
    ['-e', '$| = 1; if (my $pid = fork) { print "$pid\\n"; sleep 30 } else { setpgrp(0, 0); exit 0 }'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.after(() => holder.kill('SIGKILL'));
  const [line] = await once(holder.stdout, 'data');
  const zombiePid = Number(String(line).trim());
  const deadline = Date.now() + 2_000;
  while (!psRows().some(row => row.pid === zombiePid && row.state.startsWith('Z'))) {
    assert.ok(Date.now() < deadline, 'the forked child did not become a zombie');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return zombiePid;
}

/** Stops a fake worker whose observed descendants include `zombiePid`, shown through `describe(row)`. */
async function stopWithDescendant(zombiePid, describe) {
  let runtime;
  const readSnapshot = () =>
    psRows().map(row => (row.pid === zombiePid ? describe({ ...row, ppid: runtime.pid }) : row));
  runtime = createSubagentRuntime(baseBootstrap(), {
    workerPath: fakeWorker,
    startupTimeoutMs: 2_000,
    processSnapshot: readSnapshot,
  });
  await runtime.start();
  await runtime.stop();
  return runtime;
}

test('cleanup skips a tracked process group that only holds zombies', { skip: !processCleanupVerified }, async t => {
  const zombiePid = await zombieGroup(t);
  const runtime = await stopWithDescendant(zombiePid, row => row);
  assert.equal(runtime.status, 'stopped');
});

test(
  'cleanup tolerates a group whose last member became a zombie after it was observed',
  { skip: !processCleanupVerified },
  async t => {
    const zombiePid = await zombieGroup(t);
    // Observed alive until the first signal, as when a browser exits during cleanup.
    let signalled = false;
    const kill = process.kill.bind(process);
    t.mock.method(process, 'kill', (pid, signal) => {
      if (pid === -zombiePid) signalled = true;
      return kill(pid, signal);
    });
    const runtime = await stopWithDescendant(zombiePid, row => (signalled ? row : { ...row, state: 'S' }));
    assert.ok(signalled);
    assert.equal(runtime.status, 'stopped');
  },
);

test(
  'cleanup keeps signalling later groups when an exiting group answers EPERM',
  { skip: !processCleanupVerified },
  async t => {
    // As the worker's guardian after a crash: killpg answers EPERM while the next
    // observation still lists the exiting process as alive.
    const zombiePid = await zombieGroup(t);
    const sibling = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    t.after(() => {
      try {
        process.kill(-sibling.pid, 'SIGKILL');
      } catch {}
    });
    const siblingExit = once(sibling, 'exit');
    let readsSinceSignal;
    const kill = process.kill.bind(process);
    t.mock.method(process, 'kill', (pid, signal) => {
      if (pid === -zombiePid) readsSinceSignal ??= 0;
      return kill(pid, signal);
    });
    let runtime;
    const readSnapshot = () => {
      const exiting = readsSinceSignal === undefined || readsSinceSignal++ === 0;
      return psRows()
        .map(row => {
          if (row.pid === zombiePid) return { ...row, ppid: runtime.pid, ...(exiting ? { state: 'S' } : {}) };
          return row.pid === sibling.pid ? { ...row, ppid: runtime.pid } : row;
        })
        .sort((a, b) => Number(b.pid === zombiePid) - Number(a.pid === zombiePid));
    };
    runtime = createSubagentRuntime(baseBootstrap(), {
      workerPath: fakeWorker,
      startupTimeoutMs: 2_000,
      processSnapshot: readSnapshot,
    });
    await runtime.start();
    await runtime.stop();
    assert.equal(runtime.status, 'stopped');
    assert.deepEqual(await siblingExit, [null, 'SIGTERM']);
  },
);

test('runtime retains only a marked 64 KiB stderr tail', async t => {
  const runtime = createSubagentRuntime(
    { ...baseBootstrap(), fakeStderrBytes: 80 * 1024 },
    { workerPath: fakeWorker, startupTimeoutMs: 2_000 },
  );
  t.after(() => runtime.stop());
  await runtime.start();
  assert.ok(Buffer.byteLength(runtime.stderr) <= 64 * 1024);
  assert.match(runtime.stderr, /^\[earlier stderr truncated\]/);
});

test('stop during startup state verification cannot publish ready or restore idle', async () => {
  const runtime = createSubagentRuntime(
    { ...baseBootstrap(), fakeStateDelayMs: 150, fakeIgnoreEof: true },
    { workerPath: fakeWorker, startupTimeoutMs: 2_000 },
  );
  const events = [];
  runtime.subscribe(event => events.push(event.type));
  const starting = runtime.start();
  await new Promise(resolve => setTimeout(resolve, 40));
  const stopping = runtime.stop();
  await assert.rejects(starting, /stopped|stopping/i);
  await stopping;
  assert.equal(runtime.status, 'stopped');
  assert.equal(events.includes('ready'), false);
});

test('stop bounds an incomplete startup instead of leaving its promise pending', async () => {
  const runtime = createSubagentRuntime(
    { ...baseBootstrap(), fakeNoReady: true },
    { workerPath: fakeWorker, startupTimeoutMs: 30_000, requestTimeoutMs: 200 },
  );
  const starting = runtime.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  await runtime.stop();
  await assert.rejects(starting, /startup was stopped/i);
  assert.equal(runtime.status, 'stopped');
});

test('runtime classifies length and stop is idempotent and final', async () => {
  const bootstrap = { ...baseBootstrap(), fakeStopReason: 'length' };
  const runtime = createSubagentRuntime(bootstrap, {
    workerPath: fakeWorker,
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 1_000,
  });
  await runtime.start();
  const run = await runtime.prompt('long');
  assert.equal((await run.result).status, 'incomplete');
  await Promise.all([runtime.stop(), runtime.stop()]);
  assert.equal(runtime.status, 'stopped');
  await assert.rejects(runtime.prompt('too late'), /stopped/i);
});

test('runtime reports an authoritative assistant message with no text as no_output', async t => {
  const runtime = createSubagentRuntime(
    { ...baseBootstrap(), fakeNoText: true },
    { workerPath: fakeWorker, startupTimeoutMs: 2_000 },
  );
  t.after(() => runtime.stop());
  await runtime.start();
  const run = await runtime.prompt('empty');
  const result = await run.result;
  assert.equal(result.status, 'no_output');
  assert.equal(result.text, '');
});

test('stop clears queued work before aborting an active run', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subagent-order-'));
  const commandFile = join(directory, 'commands.txt');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = createSubagentRuntime(
    { ...baseBootstrap(), fakeMessageDelayMs: 5_000, fakeCommandFile: commandFile },
    { workerPath: fakeWorker, startupTimeoutMs: 2_000 },
  );
  const run = await runtime.start().then(() => runtime.prompt('active'));
  await runtime.stop();
  assert.equal((await run.result).status, 'aborted');
  const commands = (await readFile(commandFile, 'utf8')).trim().split('\n');
  assert.ok(commands.indexOf('clear_queue') < commands.indexOf('abort'));
});

test(
  'cooperative worker exit still removes surviving ordinary and detached descendants',
  { skip: !processCleanupVerified },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'subagent-cooperative-stop-'));
    const pidFile = join(directory, 'pids.json');
    t.after(async () => {
      try {
        const pids = JSON.parse(await readFile(pidFile, 'utf8'));
        for (const pid of pids) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {}
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
      } catch {}
      await rm(directory, { recursive: true, force: true });
    });
    const runtime = createSubagentRuntime(
      { ...baseBootstrap(), instanceId: 'cooperative-worker', fakeDescendants: true, fakePidFile: pidFile },
      { workerPath: fakeWorker, startupTimeoutMs: 2_000 },
    );
    await runtime.start();
    const pids = JSON.parse(await readFile(pidFile, 'utf8'));
    await runtime.stop();
    const exists = pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(pids.map(exists), [false, false, false]);
  },
);

test(
  'a worker crash still removes descendants captured before reparenting',
  { skip: !processCleanupVerified },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'subagent-crash-stop-'));
    const pidFile = join(directory, 'pids.json');
    t.after(async () => {
      try {
        const pids = JSON.parse(await readFile(pidFile, 'utf8'));
        for (const pid of pids) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {}
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
      } catch {}
      await rm(directory, { recursive: true, force: true });
    });
    const runtime = createSubagentRuntime(
      { ...baseBootstrap(), instanceId: 'crashing-worker', fakeSpawnAndCrashOnPrompt: true, fakePidFile: pidFile },
      { workerPath: fakeWorker, startupTimeoutMs: 2_000 },
    );
    await runtime.start();
    await assert.rejects(runtime.prompt('spawn then crash'), /ended|exited/i);
    const pids = JSON.parse(await readFile(pidFile, 'utf8'));
    const deadline = Date.now() + 3_000;
    while (!['stopped', 'failed'].includes(runtime.status) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 25));
    const exists = pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(pids.map(exists), [false, false, false]);
    assert.equal(runtime.status, 'stopped');
  },
);

test(
  'forced stop removes the targeted POSIX process groups without touching another worker',
  { skip: process.platform === 'win32' },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'subagent-stop-'));
    const pidFile = join(directory, 'pids.json');
    t.after(() => rm(directory, { recursive: true, force: true }));
    const blocked = createSubagentRuntime(
      {
        ...baseBootstrap(),
        instanceId: 'blocked-worker',
        fakeIgnoreSigterm: true,
        fakeIgnoreEof: true,
        fakeDescendants: true,
        fakePidFile: pidFile,
      },
      { workerPath: fakeWorker, startupTimeoutMs: 2_000, requestTimeoutMs: 200 },
    );
    const survivor = createSubagentRuntime(
      { ...baseBootstrap(), instanceId: 'surviving-worker' },
      { workerPath: fakeWorker, startupTimeoutMs: 2_000, requestTimeoutMs: 500 },
    );
    t.after(() => Promise.all([blocked.stop(), survivor.stop()]));
    await Promise.all([blocked.start(), survivor.start()]);
    const pids = JSON.parse(await readFile(pidFile, 'utf8'));
    const survivorPid = survivor.pid;
    await blocked.stop();
    const exists = pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(pids.map(exists), [false, false, false]);
    assert.equal(exists(survivorPid), true);
    const run = await survivor.prompt('still alive');
    assert.equal((await run.result).status, 'completed');
  },
);

test('RPC rejects timeout, malformed input, unknown ids and pending requests on close', async () => {
  {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const rpc = createRpcConnection({ readable, writable, requestTimeoutMs: 20 });
    await assert.rejects(rpc.request('slow'), /timed out/i);
    rpc.close();
  }
  for (const line of ['{bad}\n', '{"id":"unknown","type":"response","command":"x","success":true}\n']) {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const rpc = createRpcConnection({ readable, writable, requestTimeoutMs: 500 });
    const pending = rpc.request('wait');
    readable.write(line);
    await assert.rejects(pending, /invalid JSON|unknown response id/i);
  }
  {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const rpc = createRpcConnection({ readable, writable, requestTimeoutMs: 500 });
    const pending = rpc.request('wait');
    readable.end();
    await assert.rejects(pending, /ended/i);
  }
  {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const rpc = createRpcConnection({ readable, writable, requestTimeoutMs: 500 });
    const pending = rpc.request('wait');
    writable.destroy(new Error('stdin broke'));
    await assert.rejects(pending, /writable stream (?:failed|is closed)|write failed/i);
  }
  {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const rpc = createRpcConnection({ readable, writable, requestTimeoutMs: 500 });
    let input = '';
    writable.on('data', chunk => {
      input += chunk;
    });
    const result = rpc.request('once');
    await new Promise(resolve => setImmediate(resolve));
    const command = JSON.parse(input);
    const response = `${JSON.stringify({ id: command.id, type: 'response', command: 'once', success: true })}\n`;
    readable.write(response);
    await result;
    const closed = new Promise(resolve => rpc.subscribeClose(resolve));
    readable.write(response);
    assert.match((await closed).message, /unknown response id/i);
  }
});
