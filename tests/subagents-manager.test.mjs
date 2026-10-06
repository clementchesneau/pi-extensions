import assert from 'node:assert/strict';
import test from 'node:test';
import { SubagentManager } from '../packages/subagents/manager.js';

function fixture({ maxConcurrent = 4, autoDelegate = true } = {}) {
  const started = [];
  const runtimes = [];
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ version: 1, maxConcurrent, autoDelegate }),
    createRuntime: async agent => {
      const runtime = {
        prompt: async task => {
          started.push({ agentId: agent.agentId, task });
          return {
            runId: `runtime-${started.length}`,
            result: new Promise(resolve => {
              runtime.resolve = resolve;
            }),
          };
        },
        steer: async message => {
          runtime.steered = message;
        },
        stop: async () => {
          runtime.stopped = true;
        },
      };
      runtimes.push(runtime);
      return runtime;
    },
  });
  return { manager, started, runtimes };
}

test('capability selection provenance remains available after restoration and continuations', async () => {
  const { manager, runtimes } = fixture();
  const selectionSource = { model: 'hérité', reasoning: 'défini', tools: 'hérités' };
  const first = await manager.start({ title: 'Selection', task: 'work', context: '', selectionSource });
  assert.deepEqual(manager.findAgent(first.agentId).selectionSource, selectionSource);
  assert.equal(manager.compactAgents()[0].selectionSource, undefined);
  runtimes[0].resolve({ status: 'completed', text: 'done' });
  await manager.wait({ agentIds: [first.agentId] });
  await manager.send({ agentId: first.agentId, message: 'continue' });
  assert.deepEqual(manager.findAgent(first.agentId).selectionSource, selectionSource);
  const restored = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => {},
  });
  restored.restore([manager.getAgent(first.agentId)]);
  assert.deepEqual(restored.findAgent('A1').selectionSource, selectionSource);
  await manager.shutdown();
});

test('each run exposes its own initial instruction only through full public views', async () => {
  const { manager, runtimes } = fixture();
  const first = await manager.start({ title: 'Instructions', task: 'first\nmission', context: 'separate context' });
  assert.deepEqual(manager.findAgent(first.alias).run.instructions, ['first\nmission']);
  assert.equal(Object.hasOwn(manager.compactAgents()[0].runs[0], 'instructions'), false);
  runtimes[0].resolve({ status: 'completed', text: 'done' });
  await manager.wait({ agentIds: [first.agentId] });
  await manager.send({ agentId: first.agentId, message: 'follow up' });
  assert.deepEqual(
    manager.findAgent(first.alias).runs.map(run => run.instructions),
    [['first\nmission'], ['follow up']],
  );
  assert.equal(Object.hasOwn(manager.compactAgents()[0].run, 'instructions'), false);
  manager.findAgent(first.alias).run.instructions.push('not an instruction');
  assert.deepEqual(manager.findAgent(first.alias).run.instructions, ['follow up']);
  await manager.shutdown();
});

test('only acknowledged steer messages are appended to their run and published', async () => {
  const { manager, runtimes } = fixture();
  const events = [];
  manager.subscribe(event => events.push(event));
  const first = await manager.start({ title: 'Instructions', task: 'initial' });
  let acknowledge;
  runtimes[0].steer = () =>
    new Promise(resolve => {
      acknowledge = resolve;
    });
  const pending = manager.send({ agentId: first.agentId, message: 'extra\ninstruction' });
  assert.deepEqual(manager.findAgent(first.alias).run.instructions, ['initial']);
  acknowledge();
  await pending;
  assert.deepEqual(events.at(-1).agent.run.instructions, ['initial', 'extra\ninstruction']);
  runtimes[0].steer = async () => {
    throw new Error('steer rejected');
  };
  await assert.rejects(manager.send({ agentId: first.agentId, message: 'rejected' }), /steer rejected/);
  assert.deepEqual(manager.findAgent(first.alias).run.instructions, ['initial', 'extra\ninstruction']);
  runtimes[0].resolve({ status: 'completed', text: 'done' });
  await manager.wait({ agentIds: [first.agentId] });
  await manager.send({ agentId: first.agentId, message: 'continuation' });
  runtimes[0].steer = async () => {};
  await manager.send({ agentId: first.agentId, message: 'continuation extra' });
  assert.deepEqual(
    manager.findAgent(first.alias).runs.map(run => run.instructions),
    [
      ['initial', 'extra\ninstruction'],
      ['continuation', 'continuation extra'],
    ],
  );
  await manager.shutdown();
});

test('restoring old runs exposes empty instructions without inferring them from the global task', () => {
  const { manager } = fixture();
  const archive = {
    agentId: 'archived',
    alias: 'A1',
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    title: 'Old',
    task: 'global task',
    runs: [
      { runId: 'old', state: 'completed' },
      { runId: 'new', state: 'running', instructions: ['known', 'extra'] },
    ],
  };
  manager.restore([archive]);
  assert.deepEqual(
    manager.findAgent('A1').runs.map(run => run.instructions),
    [[], ['known', 'extra']],
  );
  assert.ok(manager.compactAgents()[0].runs.every(run => !Object.hasOwn(run, 'instructions')));
  assert.equal(manager.findAgent('A1').run.state, 'cancelled');
  assert.equal(archive.runs[0].instructions, undefined);
});

test('restoration rejects recorded instructions that are not arrays of strings', () => {
  for (const instructions of ['not an array', ['valid', 42]]) {
    const { manager } = fixture();
    assert.throws(
      () =>
        manager.restore([
          {
            agentId: 'archived',
            alias: 'A1',
            ownerSessionId: 'session-1',
            branchId: 'branch-1',
            title: 'Invalid',
            runs: [{ runId: 'run', state: 'completed', instructions }],
          },
        ]),
      /Invalid saved subagent metadata/,
    );
  }
});

test('a transcript page belongs to the selected agent and its private session', async () => {
  let received;
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => ({
      prompt: async () => ({
        runId: 'runtime',
        result: Promise.resolve({
          status: 'completed',
          text: 'ok',
          sessionStats: { sessionFile: '/private/child.jsonl' },
        }),
      }),
      stop: async () => {},
    }),
    readTranscript: async (agent, options) => {
      received = { agent, options };
      return { text: 'page', nextCursor: 4 };
    },
  });
  const agent = await manager.start({ title: 'Read', task: 'work', context: '' });
  await manager.wait({ agentIds: [agent.agentId] });
  assert.equal((await manager.transcript({ agentId: agent.agentId, cursor: 5 })).text, 'page');
  assert.equal(received.options.sessionFile, '/private/child.jsonl');
  assert.equal(received.options.cursor, 5);
  await assert.rejects(manager.transcript({ agentId: 'unknown' }), /Unknown subagent/);
});

test('runtime tool events update bounded activity without persisting token or reasoning deltas', async () => {
  let listener;
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => ({
      subscribe: callback => {
        listener = callback;
      },
      prompt: async () => ({ runId: 'runtime-1', result: new Promise(() => {}) }),
      stop: async () => {},
    }),
  });
  const agent = await manager.start({ title: 'Inspect', task: 'work', context: '' });
  listener({ type: 'rpc_event', data: { type: 'tool_execution_start', toolName: 'read' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(manager.getAgent(agent.agentId).run.activity, /read/);
  for (let index = 0; index < 50; index += 1)
    listener({ type: 'rpc_event', data: { type: 'message_update', text: 'secret thinking' } });
  assert.ok(manager.getAgent(agent.agentId).run.activities.length <= 32);
  assert.equal(JSON.stringify(manager.getAgent(agent.agentId)).includes('secret thinking'), false);
  await manager.shutdown();
});

test('streaming display events reach subscribers without entering persisted agent state', async () => {
  let emit;
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => ({
      subscribe: callback => {
        emit = callback;
      },
      prompt: async () => ({ runId: 'runtime-1', result: new Promise(() => {}) }),
      stop: async () => {},
    }),
  });
  const agent = await manager.start({ title: 'Live', task: 'work' });
  const received = [];
  const detach = manager.subscribeActivity(event => received.push(event));
  emit({
    type: 'rpc_event',
    data: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'private stream' },
    },
  });
  assert.equal(received[0].agentId, agent.agentId);
  assert.equal(received[0].runId, agent.runId);
  assert.equal(received[0].data.assistantMessageEvent.delta, 'private stream');
  assert.doesNotMatch(JSON.stringify(manager.getAgent(agent.agentId)), /private stream/);
  detach();
  emit({
    type: 'rpc_event',
    data: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'later' } },
  });
  assert.equal(received.length, 1);
  await manager.shutdown();
});

test('atomically accepts no more than four simultaneous runs and does not represent rejection as active', async () => {
  const { manager, started } = fixture();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => manager.start({ title: `Task ${i}`, task: `work ${i}`, context: '' })),
  );
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 4);
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
  assert.match(outcomes.find(outcome => outcome.status === 'rejected').reason.message, /capacity/i);
  assert.equal(started.length, 4);
  assert.equal(
    manager.list().items.filter(agent => ['starting', 'running', 'stopping'].includes(agent.run.state)).length,
    4,
  );
});

test('older run identities remain discoverable through paginated agent history', async () => {
  const { manager, runtimes } = fixture({ maxConcurrent: 1 });
  const first = await manager.start({ title: 'History', task: 'first', context: '' });
  runtimes[0].resolve({ status: 'completed', text: 'first' });
  await manager.wait({ agentIds: [first.agentId] });
  for (let index = 0; index < 11; index += 1) {
    const continued = await manager.send({ agentId: first.agentId, message: `follow-up ${index}` });
    runtimes[0].resolve({ status: 'completed', text: `answer ${index}` });
    await manager.wait({ agentIds: [first.agentId] });
    assert.equal(manager.getAgent(first.agentId).run.runId, continued.runId);
  }
  const firstPage = manager.list({ agentId: first.agentId, cursor: 0, limit: 5 });
  assert.equal(firstPage.items[0].runId, first.runId);
  assert.equal(firstPage.nextCursor, 5);
  const remaining = manager.list({ agentId: first.agentId, cursor: firstPage.nextCursor, limit: 100 });
  assert.equal(remaining.items.length, 7);
  assert.equal(remaining.nextCursor, undefined);
  assert.equal((await manager.result({ agentId: first.agentId, runId: first.runId })).result, 'first');
});

test('a finished agent keeps immutable prior results and a continuation creates a new admitted run', async () => {
  const { manager, runtimes } = fixture({ maxConcurrent: 1 });
  const agent = await manager.start({ title: 'Inspect', task: 'first', context: 'context' });
  runtimes[0].resolve({ status: 'completed', text: 'first answer', usage: { tokens: 1 } });
  await manager.wait({ agentIds: [agent.agentId] });
  const first = await manager.result({ agentId: agent.agentId, runId: agent.runId });
  assert.equal(first.result, 'first answer');
  const continued = await manager.send({ agentId: agent.agentId, message: 'clarify' });
  assert.notEqual(continued.runId, agent.runId);
  assert.equal(runtimes.length, 1);
  assert.equal((await manager.result({ agentId: agent.agentId, runId: agent.runId })).result, 'first answer');
});

test('abort during the RPC prompt acknowledgement closes the child before start can return accepted', async () => {
  let acknowledge;
  let entered;
  const promptEntered = new Promise(resolve => {
    entered = resolve;
  });
  const acknowledgement = new Promise(resolve => {
    acknowledge = resolve;
  });
  let stops = 0;
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => ({
      prompt: async () => {
        entered();
        return acknowledgement;
      },
      stop: async () => {
        stops += 1;
      },
    }),
  });
  const controller = new AbortController();
  const pending = manager.start({ title: 'Slow ack', task: 'work', context: '', signal: controller.signal });
  await promptEntered;
  controller.abort();
  acknowledge({ runId: 'worker', result: new Promise(() => {}) });
  await assert.rejects(pending, /abort/i);
  assert.equal(stops, 1);
  assert.equal(manager.list().items[0].run.state, 'cancelled');
});

test('an abort during admission or slow startup cannot prompt a worker', async () => {
  let release;
  const waiting = new Promise(resolve => {
    release = resolve;
  });
  let prompts = 0;
  let stops = 0;
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => {
      await waiting;
      return {
        prompt: async () => {
          prompts += 1;
        },
        stop: async () => {
          stops += 1;
        },
      };
    },
  });
  const controller = new AbortController();
  const pending = manager.start({ title: 'Slow', task: 'work', context: '', signal: controller.signal });
  while (manager.list().items[0]?.run?.state !== 'starting') await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  release();
  await assert.rejects(pending, /abort/i);
  assert.equal(prompts, 0);
  assert.equal(stops, 1);
});

test('confirmation is required when auto delegation is disabled, and absence of UI rejects without starting', async () => {
  let confirmed = 0;
  const { manager, started } = fixture({ autoDelegate: false });
  manager.confirm = async () => {
    confirmed += 1;
    return false;
  };
  await assert.rejects(manager.start({ title: 'Ask', task: 'work', context: '' }), /declined/i);
  assert.equal(confirmed, 1);
  assert.equal(started.length, 0);
  manager.confirm = undefined;
  await assert.rejects(manager.start({ title: 'No UI', task: 'work', context: '' }), /confirmation.*unavailable/i);
  assert.equal(started.length, 0);
});

test('a queued confirmation is never shown after its run was cancelled', async () => {
  let releaseFirst;
  let enteredFirst;
  const firstEntered = new Promise(resolve => {
    enteredFirst = resolve;
  });
  const firstAnswer = new Promise(resolve => {
    releaseFirst = resolve;
  });
  let confirmations = 0;
  let runtimes = 0;
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 2, autoDelegate: false }),
    createRuntime: async () => {
      runtimes += 1;
      throw new Error('must not start');
    },
    confirm: async () => {
      confirmations += 1;
      enteredFirst();
      return firstAnswer;
    },
  });
  const first = manager.start({ title: 'First', task: 'work', context: '' });
  await firstEntered;
  const second = manager.start({ title: 'Second', task: 'work', context: '' });
  while (manager.list().items.length < 2) await new Promise(resolve => setImmediate(resolve));
  const secondId = manager.list().items[1].agentId;
  await manager.stop({ agentId: secondId });
  releaseFirst(false);
  await assert.rejects(first, /declined/i);
  await assert.rejects(second, /cancel/i);
  assert.equal(confirmations, 1);
  assert.equal(runtimes, 0);
  assert.equal(manager.getAgent(secondId).run.state, 'cancelled');
});

test('stopping an open confirmation aborts its dialog and frees the confirmation queue', async () => {
  let firstOpened;
  const opened = new Promise(resolve => {
    firstOpened = resolve;
  });
  let firstSignal;
  let confirmations = 0;
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 2, autoDelegate: false }),
    createRuntime: async () => {
      throw new Error('must not start');
    },
    confirm: async (_details, { signal } = {}) => {
      confirmations += 1;
      if (confirmations === 1) {
        firstSignal = signal;
        firstOpened();
        return new Promise(() => {}); // Even a UI ignoring abort must not block later admissions.
      }
      return false;
    },
  });
  const first = manager.start({ title: 'First', task: 'work', context: '' });
  await opened;
  const firstId = manager.list().items[0].agentId;
  const second = manager.start({ title: 'Second', task: 'work', context: '' });
  await manager.stop({ agentId: firstId });
  await assert.rejects(first, /cancel/i);
  await assert.rejects(second, /declined/i);
  assert.equal(firstSignal.aborted, true);
  assert.equal(confirmations, 2);
});

test('stopping a run while its runtime is starting waits for it and closes it', async () => {
  let releaseStartup;
  let enteredStartup;
  const startupEntered = new Promise(resolve => {
    enteredStartup = resolve;
  });
  const startup = new Promise(resolve => {
    releaseStartup = resolve;
  });
  const runtime = {
    prompt: async () => ({ runId: 'unused', result: Promise.resolve({ status: 'completed', text: 'unused' }) }),
    stop: async () => {
      runtime.stopped = true;
    },
  };
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => {
      enteredStartup();
      await startup;
      return runtime;
    },
  });
  const starting = manager.start({ title: 'Slow', task: 'work', context: '' });
  await startupEntered;
  const agentId = manager.list().items[0].agentId;
  const stopping = manager.stop({ agentId });
  releaseStartup();
  await stopping;
  await assert.rejects(starting, /stopped|cancelled/i);
  assert.equal(runtime.stopped, true);
  assert.equal(manager.getAgent(agentId).run.state, 'cancelled');
});

test('shutdown reports persistent cleanup failure and permits a later retry', async () => {
  let stops = 0;
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => ({
      prompt: async () => ({ runId: 'worker', result: new Promise(() => {}) }),
      stop: async () => {
        if (++stops <= 2) throw new Error('process still alive');
      },
    }),
  });
  const agent = await manager.start({ title: 'Active', task: 'work' });
  await assert.rejects(manager.shutdown(), /process still alive/);
  assert.equal(manager.getAgent(agent.agentId).run.state, 'stopping');
  assert.equal(stops, 2);
  await manager.shutdown();
  assert.equal(stops, 3);
  assert.equal(manager.getAgent(agent.agentId).run.state, 'cancelled');
});

test('shutdown finishes a run when its second cleanup attempt succeeds', async () => {
  let stops = 0;
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => ({
      prompt: async () => ({ runId: 'worker', result: new Promise(() => {}) }),
      stop: async () => {
        if (++stops === 1) throw new Error('temporary failure');
      },
    }),
  });
  const agent = await manager.start({ title: 'Active', task: 'work' });
  await manager.shutdown();
  assert.equal(stops, 2);
  assert.equal(manager.getAgent(agent.agentId).run.state, 'cancelled');
});

test('shutdown closes a completed runtime', async () => {
  const { manager, runtimes } = fixture();
  const agent = await manager.start({ title: 'Completed', task: 'work', context: '' });
  runtimes[0].resolve({ status: 'completed', text: 'done' });
  await manager.wait({ agentIds: [agent.agentId] });
  await manager.shutdown();
  assert.equal(runtimes[0].stopped, true);
});

test('after stopping an active continuation, a new run recreates the child from its archived conversation', async () => {
  const runtimes = [];
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async agent => {
      const runtime = {
        stopped: false,
        prompt: async () => {
          if (runtime.stopped) throw new Error('runtime is stopped');
          return {
            runId: `runtime-${runtimes.length}`,
            result: new Promise(resolve => {
              runtime.resolve = resolve;
            }),
          };
        },
        stop: async () => {
          runtime.stopped = true;
        },
      };
      runtimes.push({ runtime, priorSessionFile: agent.runs.findLast(run => run.sessionFile)?.sessionFile });
      return runtime;
    },
  });
  const agent = await manager.start({ title: 'History', task: 'work', context: '' });
  runtimes[0].runtime.resolve({
    status: 'completed',
    text: 'first',
    sessionStats: { sessionFile: '/private/history.jsonl' },
  });
  await manager.wait({ agentIds: [agent.agentId] });
  await manager.send({ agentId: agent.agentId, message: 'active continuation' });
  await manager.stop({ agentId: agent.agentId });
  const next = await manager.send({ agentId: agent.agentId, message: 'resume after stop' });
  assert.equal(next.state, 'running');
  assert.equal(runtimes.length, 2);
  assert.equal(runtimes[1].priorSessionFile, '/private/history.jsonl');
});

test('a failed continuation prompt retires its closed worker so a later run can resume the archived session', async () => {
  const runtimes = [];
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async agent => {
      const runtime = {
        closed: false,
        calls: 0,
        prompt: async () => {
          if (runtime.closed) throw new Error('closed runtime');
          runtime.calls += 1;
          if (runtimes.length === 1 && runtime.calls === 2) throw new Error('prompt failed');
          return {
            runId: `worker-${runtimes.length}-${runtime.calls}`,
            result: new Promise(resolve => {
              runtime.resolve = resolve;
            }),
          };
        },
        stop: async () => {
          runtime.closed = true;
        },
      };
      runtimes.push({ runtime, sessionFile: agent.runs.findLast(run => run.sessionFile)?.sessionFile });
      return runtime;
    },
  });
  const first = await manager.start({ title: 'Recover', task: 'first', context: '' });
  runtimes[0].runtime.resolve({
    status: 'completed',
    text: 'done',
    sessionStats: { sessionFile: '/private/saved.jsonl' },
  });
  await manager.wait({ agentIds: [first.agentId] });
  await assert.rejects(manager.send({ agentId: first.agentId, message: 'bad prompt' }), /prompt failed/);
  assert.equal(manager.getAgent(first.agentId).run.state, 'failed');
  assert.equal(runtimes[0].runtime.closed, true);
  const resumed = await manager.send({ agentId: first.agentId, message: 'retry' });
  assert.equal(resumed.state, 'running');
  assert.equal(runtimes.length, 2);
  assert.equal(runtimes[1].sessionFile, '/private/saved.jsonl');
});

test('a failed runtime cleanup keeps the slot and allows a later stop retry', async () => {
  let stops = 0;
  const runtime = {
    prompt: async () => {
      throw new Error('prompt failed');
    },
    stop: async () => {
      stops += 1;
      if (stops === 1) throw new Error('process still alive');
    },
  };
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => runtime,
  });
  await assert.rejects(manager.start({ title: 'Failed', task: 'work', context: '' }), /prompt failed/);
  const failed = manager.list().items[0];
  assert.equal(failed.run.state, 'stopping');
  await assert.rejects(manager.start({ title: 'Blocked', task: 'work', context: '' }), /capacity/i);
  assert.equal((await manager.stop({ agentId: failed.agentId })).state, 'cancelled');
  assert.equal(stops, 2);
});

test('a user stop racing failed-prompt cleanup shares one close and owns the final state', async () => {
  let releaseStop;
  let enteredStop;
  const stopping = new Promise(resolve => {
    releaseStop = resolve;
  });
  const stopEntered = new Promise(resolve => {
    enteredStop = resolve;
  });
  let stops = 0;
  const runtime = {
    prompt: async () => {
      throw new Error('prompt failed');
    },
    stop: async () => {
      stops += 1;
      enteredStop();
      await stopping;
    },
  };
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => runtime,
  });
  const starting = manager.start({ title: 'Race', task: 'work', context: '' });
  await stopEntered;
  const agentId = manager.list().items[0].agentId;
  const stoppingRun = manager.stop({ agentId });
  releaseStop();
  await assert.rejects(starting, /prompt failed/);
  assert.equal((await stoppingRun).state, 'cancelled');
  assert.equal(stops, 1);
});

test('a stopped child without a saved conversation cannot silently resume from an empty session', async () => {
  const { manager } = fixture();
  const agent = await manager.start({ title: 'No archive', task: 'work', context: '' });
  await manager.stop({ agentId: agent.agentId });
  await assert.rejects(manager.send({ agentId: agent.agentId, message: 'resume' }), /transcription.*unavailable/i);
  assert.equal(manager.getAgent(agent.agentId).runs.length, 1);
});

test('a restored continuation retains its persisted child session reference', async () => {
  const first = fixture();
  const agent = await first.manager.start({ title: 'History', task: 'work', context: '' });
  first.runtimes[0].resolve({
    status: 'completed',
    text: 'done',
    sessionStats: { sessionFile: '/private/child.jsonl' },
  });
  await first.manager.wait({ agentIds: [agent.agentId] });
  const restored = first.manager.getAgent(agent.agentId);
  let received;
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async value => {
      received = value.runs.findLast(run => run.sessionFile)?.sessionFile;
      return {
        prompt: async () => ({ runId: 'continuation', result: new Promise(() => {}) }),
        steer: async () => {},
        stop: async () => {},
      };
    },
  });
  manager.restore([restored]);
  await manager.send({ agentId: agent.agentId, message: 'continue' });
  assert.equal(received, '/private/child.jsonl');
});

test('stopping a continuation during runtime startup closes it without starting work', async () => {
  const first = fixture();
  const agent = await first.manager.start({ title: 'Continue', task: 'work', context: '' });
  first.runtimes[0].resolve({
    status: 'completed',
    text: 'done',
    sessionStats: { sessionFile: '/private/child.jsonl' },
  });
  await first.manager.wait({ agentIds: [agent.agentId] });
  let releaseStartup;
  let enteredStartup;
  const startupEntered = new Promise(resolve => {
    enteredStartup = resolve;
  });
  const startup = new Promise(resolve => {
    releaseStartup = resolve;
  });
  let releaseStop;
  const stopped = new Promise(resolve => {
    releaseStop = resolve;
  });
  let stops = 0;
  const runtime = {
    prompt: async () => {
      throw new Error('must not prompt');
    },
    stop: async () => {
      stops += 1;
      await stopped;
    },
  };
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => {
      enteredStartup();
      await startup;
      return runtime;
    },
  });
  manager.restore([first.manager.getAgent(agent.agentId)]);
  const sending = manager.send({ agentId: agent.agentId, message: 'continue' });
  const sendingError = assert.rejects(sending, /stopped|cancelled/i);
  await startupEntered;
  const stopping = manager.stop({ agentId: agent.agentId });
  releaseStartup();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 1);
  releaseStop();
  await sendingError;
  assert.equal((await stopping).state, 'cancelled');
  assert.equal(stops, 1);
  assert.equal(manager.getAgent(agent.agentId).run.state, 'cancelled');
});

test('a restored continuation without a child session reference is rejected', async () => {
  let createCalls = 0;
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => {
      createCalls += 1;
      throw new Error('must not create');
    },
  });
  manager.restore([
    {
      agentId: '123e4567-e89b-42d3-a456-426614174000',
      alias: 'A1',
      ownerSessionId: 'session-1',
      branchId: 'branch-1',
      title: 'Archived',
      task: 'work',
      context: '',
      runs: [{ runId: '223e4567-e89b-42d3-a456-426614174000', state: 'completed' }],
    },
  ]);
  await assert.rejects(
    manager.send({ agentId: '123e4567-e89b-42d3-a456-426614174000', message: 'continue' }),
    /transcription.*unavailable/i,
  );
  assert.equal(createCalls, 0);
});

test('a continuation refuses changed captured capabilities before creating a worker', async () => {
  let created = 0;
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => {
      created += 1;
      return {
        prompt: async () => ({ runId: 'run', result: Promise.resolve({ status: 'completed', text: 'done' }) }),
        stop: async () => {},
      };
    },
  });
  const agent = await manager.start({
    title: 'Restricted',
    task: 'work',
    context: '',
    capabilitySnapshot: { tools: ['read'] },
  });
  await manager.wait({ agentIds: [agent.agentId] });
  await assert.rejects(
    manager.send({
      agentId: agent.agentId,
      message: 'continue',
      capabilities: { capabilitySnapshot: { tools: ['bash'] } },
    }),
    /capabilities no longer match/i,
  );
  assert.equal(created, 1);
  assert.equal(manager.getAgent(agent.agentId).runs.length, 1);
});

test('a terminal result is not published as completed when metadata persistence fails', async () => {
  const runtime = {
    prompt: async () => ({ runId: 'runtime-1', result: Promise.resolve({ status: 'completed', text: 'done' }) }),
    stop: async () => {},
  };
  const events = [];
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => runtime,
    persist: async agent => {
      if (agent.run?.state === 'completed') throw new Error('disk unavailable');
    },
  });
  manager.subscribe(event => events.push(event));
  const agent = await manager.start({ title: 'Persist', task: 'work', context: '' });
  await manager.wait({ agentIds: [agent.agentId] });
  assert.equal(manager.getAgent(agent.agentId).run.state, 'failed');
  assert.equal(
    events.some(event => event.state === 'completed'),
    false,
  );
});

test('a startup cannot be accepted or announced before its metadata is archived', async () => {
  let created = 0;
  const events = [];
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => {
      created += 1;
      throw new Error('must not start');
    },
    persist: async () => {
      throw new Error('disk unavailable');
    },
  });
  manager.subscribe(event => events.push(event.state));
  await assert.rejects(manager.start({ title: 'Persist', task: 'work', context: '' }), /disk unavailable/);
  assert.equal(created, 0);
  assert.deepEqual(events, ['failed']);
});

test('prompt failure during an ongoing stop does not release capacity or overwrite cancellation', async () => {
  let rejectPrompt;
  let releaseStop;
  const prompt = new Promise((_, reject) => {
    rejectPrompt = reject;
  });
  const stopped = new Promise(resolve => {
    releaseStop = resolve;
  });
  let enteredStop;
  const stopEntered = new Promise(resolve => {
    enteredStop = resolve;
  });
  let prompts = 0;
  const runtime = {
    prompt: async () => {
      prompts += 1;
      return prompts === 1
        ? {
            runId: 'first',
            result: Promise.resolve({
              status: 'completed',
              text: 'done',
              sessionStats: { sessionFile: '/private/session.jsonl' },
            }),
          }
        : prompt;
    },
    stop: async () => {
      enteredStop();
      await stopped;
    },
  };
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => runtime,
  });
  const first = await manager.start({ title: 'History', task: 'work', context: '' });
  await manager.wait({ agentIds: [first.agentId] });
  const sending = manager.send({ agentId: first.agentId, message: 'follow up' });
  while (prompts < 2) await new Promise(resolve => setImmediate(resolve));
  const stopping = manager.stop({ agentId: first.agentId });
  await stopEntered;
  rejectPrompt(new Error('prompt failed'));
  await assert.rejects(sending, /prompt failed/);
  assert.equal(manager.getAgent(first.agentId).run.state, 'stopping');
  await assert.rejects(manager.start({ title: 'Blocked', task: 'work', context: '' }), /capacity/i);
  releaseStop();
  assert.equal((await stopping).state, 'cancelled');
});

test('stopping during result settlement does not enter an illegal terminal state', async () => {
  let settle;
  const runtime = {
    prompt: async () => ({
      runId: 'runtime-1',
      result: new Promise(resolve => {
        settle = resolve;
      }),
    }),
    stop: async () => {
      settle({ status: 'completed', text: 'late answer' });
      await new Promise(resolve => setImmediate(resolve));
    },
  };
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => runtime,
  });
  const agent = await manager.start({ title: 'Race', task: 'work', context: '' });
  assert.equal((await manager.stop({ agentId: agent.agentId })).state, 'cancelled');
  assert.equal(manager.getAgent(agent.agentId).run.state, 'cancelled');
});

test('list and wait return compact state while result and instructions remain available separately', async () => {
  const { manager, runtimes } = fixture();
  const task = 'INITIAL_INSTRUCTION'.repeat(1000);
  const addition = 'ADDITIONAL_INSTRUCTION'.repeat(1000);
  const agent = await manager.start({ title: 'Large result', task, context: '' });
  await manager.send({ agentId: agent.agentId, message: addition });
  runtimes[0].resolve({ status: 'completed', text: 'X'.repeat(100_000) });
  const waited = await manager.wait({ agentIds: [agent.agentId] });
  assert.equal(waited[0].state, 'completed');
  assert.equal(JSON.stringify(waited).includes('XXXXX'), false);
  const listed = manager.list();
  assert.equal(JSON.stringify(listed).includes('XXXXX'), false);
  for (const view of [waited, listed, manager.compactAgents()]) {
    assert.doesNotMatch(JSON.stringify(view), /instructions|INITIAL_INSTRUCTION|ADDITIONAL_INSTRUCTION/);
  }
  assert.deepEqual(manager.findAgent(agent.alias).run.instructions, [task, addition]);
  assert.equal((await manager.result({ agentId: agent.agentId, runId: agent.runId })).result.length, 100_000);
});

test('result pages omit large instructions while full agent views, events and persistence retain them', async t => {
  for (const stored of [false, true])
    await t.test(stored ? 'stored pages' : 'inline result', async () => {
      const instruction = 'I'.repeat(32 * 1024);
      const events = [];
      const snapshots = [];
      const manager = new SubagentManager({
        ownerSessionId: 'session-1',
        branchId: 'branch-1',
        getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
        createRuntime: async () => ({
          prompt: async () => ({ runId: 'runtime', result: Promise.resolve({ status: 'completed', text: 'answer' }) }),
          stop: async () => {},
        }),
        persist: async agent => {
          snapshots.push(agent);
        },
        ...(stored
          ? {
              saveResult: async () => {},
              readResult: async (_agent, _run, { cursor = 0 }) => ({
                text: cursor === 0 ? 'ans' : 'wer',
                cursor,
                nextCursor: cursor === 0 ? 3 : undefined,
              }),
            }
          : {}),
      });
      manager.subscribe(event => events.push(event));
      const agent = await manager.start({ title: 'Large instruction', task: instruction });
      await manager.wait({ agentIds: [agent.agentId] });
      for (const cursor of stored ? [0, 3] : [undefined]) {
        const result = await manager.result({ agentId: agent.agentId, runId: agent.runId, cursor, maxBytes: 3 });
        assert.equal(Object.hasOwn(result, 'instructions'), false);
        assert.equal(result.text ?? result.result, stored ? (cursor === 0 ? 'ans' : 'wer') : 'answer');
      }
      assert.deepEqual(manager.findAgent(agent.alias).run.instructions, [instruction]);
      assert.deepEqual(events.at(-1).agent.run.instructions, [instruction]);
      assert.deepEqual(snapshots.at(-1).runs[0].instructions, [instruction]);
      await manager.shutdown();
    });
});

test('active agents beyond the first list page remain visible to lifecycle control', async () => {
  const { manager, runtimes } = fixture({ maxConcurrent: 1 });
  for (let index = 0; index < 50; index += 1) {
    const agent = await manager.start({ title: `Done ${index}`, task: 'work', context: '' });
    runtimes.at(-1).resolve({ status: 'completed', text: 'done' });
    await manager.wait({ agentIds: [agent.agentId] });
  }
  const active = await manager.start({ title: 'Still active', task: 'work', context: '' });
  assert.equal(manager.list().items.length, 50);
  assert.deepEqual(manager.activeAgentIds(), [active.agentId]);
  assert.equal(manager.findAgent('A51').agentId, active.agentId);
});

test('a rejected continuation does not close its previously completed worker', async () => {
  const { manager, runtimes } = fixture({ maxConcurrent: 1 });
  const first = await manager.start({ title: 'First', task: 'work', context: '' });
  runtimes[0].resolve({ status: 'completed', text: 'done' });
  await manager.wait({ agentIds: [first.agentId] });
  const second = await manager.start({ title: 'Second', task: 'work', context: '' });
  await assert.rejects(manager.send({ agentId: first.agentId, message: 'later' }), /capacity/i);
  assert.equal(runtimes[0].stopped, undefined);
  runtimes[1].resolve({ status: 'completed', text: 'done' });
  await manager.wait({ agentIds: [second.agentId] });
  const continued = await manager.send({ agentId: first.agentId, message: 'later' });
  assert.equal(continued.continued, true);
  assert.equal(runtimes.length, 2);
});

test('restoring an original session retains archives from inactive branches for later tree navigation', () => {
  const { manager } = fixture();
  const id = '123e4567-e89b-42d3-a456-426614174000';
  manager.restore(
    [
      {
        agentId: id,
        alias: 'A1',
        ownerSessionId: 'session-1',
        branchId: 'branch-old',
        title: 'Archived',
        runs: [{ runId: 'r', state: 'completed' }],
      },
    ],
    { branchIds: ['branch-1'] },
  );
  manager.setBranchId('branch-old');
  assert.equal(manager.getAgent(id).title, 'Archived');
  assert.equal(manager.assertCurrentBranch(id).agentId, id);
});

test('new admissions use the branch selected after tree navigation', async () => {
  const { manager } = fixture();
  manager.setBranchId('branch-2');
  const started = await manager.start({ title: 'New branch', task: 'work', context: '' });
  assert.equal(manager.getAgent(started.agentId).branchId, 'branch-2');
});

test('wait with an already aborted signal rejects without cancelling the running child', async () => {
  const { manager, runtimes } = fixture();
  const agent = await manager.start({ title: 'Active', task: 'work', context: '' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    manager.wait({ agentIds: [agent.agentId], signal: controller.signal, timeoutMs: 100 }),
    /cancel/i,
  );
  assert.equal(runtimes[0].stopped, undefined);
  await manager.stop({ agentId: agent.agentId });
});

test('wait can target an older run while a continuation is still active', async () => {
  const { manager, runtimes } = fixture({ maxConcurrent: 1 });
  const first = await manager.start({ title: 'History', task: 'first', context: '' });
  runtimes[0].resolve({ status: 'completed', text: 'first' });
  await manager.wait({ agentIds: [first.agentId] });
  const current = await manager.send({ agentId: first.agentId, message: 'more' });
  const old = await manager.wait({ agentIds: [first.agentId], runIds: [first.runId], timeoutMs: 20 });
  assert.deepEqual(
    old.map(run => run.runId),
    [first.runId],
  );
  assert.equal(old[0].state, 'completed');
  assert.equal(manager.getAgent(first.agentId).run.runId, current.runId);
  await assert.rejects(manager.wait({ agentIds: [first.agentId], timeoutMs: 20 }), /timed out/i);
  await assert.rejects(manager.wait({ agentIds: [first.agentId], runIds: [] }), /runIds/i);
  await assert.rejects(manager.wait({ agentIds: [first.agentId], runIds: ['missing'] }), /Unknown run/i);
  await manager.stop({ agentId: first.agentId });
});

test('wait(any) returns an already completed run without waiting for an active sibling', async () => {
  const { manager, runtimes } = fixture({ maxConcurrent: 2 });
  const done = await manager.start({ title: 'Done', task: 'one', context: '' });
  runtimes[0].resolve({ status: 'completed', text: 'answer' });
  await manager.wait({ agentIds: [done.agentId] });
  const active = await manager.start({ title: 'Active', task: 'two', context: '' });
  const states = await manager.wait({ agentIds: [done.agentId, active.agentId], mode: 'any', timeoutMs: 20 });
  assert.deepEqual(
    states.map(run => run.state),
    ['completed', 'running'],
  );
  await manager.stop({ agentId: active.agentId });
});

test('simultaneous stops of the same run share one stop and both report cancellation', async () => {
  let releaseStop;
  const stopping = new Promise(resolve => {
    releaseStop = resolve;
  });
  let stops = 0;
  const manager = new SubagentManager({
    ownerSessionId: 'session-1',
    branchId: 'branch-1',
    getConfig: async () => ({ maxConcurrent: 1, autoDelegate: true }),
    createRuntime: async () => ({
      prompt: async () => ({ runId: 'runtime', result: new Promise(() => {}) }),
      stop: async () => {
        stops += 1;
        await stopping;
      },
    }),
  });
  const agent = await manager.start({ title: 'Stop', task: 'work', context: '' });
  const first = manager.stop({ agentId: agent.agentId });
  const second = manager.stop({ agentId: agent.agentId });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 1);
  releaseStop();
  assert.deepEqual(
    (await Promise.all([first, second])).map(run => run.state),
    ['cancelled', 'cancelled'],
  );
  assert.equal(stops, 1);
});

test('stopping one active run preserves other workers and releases capacity only after stop completes', async () => {
  const { manager, runtimes } = fixture({ maxConcurrent: 2 });
  const first = await manager.start({ title: 'One', task: 'one', context: '' });
  await manager.start({ title: 'Two', task: 'two', context: '' });
  await manager.stop({ agentId: first.agentId });
  assert.equal(runtimes[0].stopped, true);
  assert.equal(runtimes[1].stopped, undefined);
  assert.equal(manager.getAgent(first.agentId).run.state, 'cancelled');
  const third = await manager.start({ title: 'Three', task: 'three', context: '' });
  assert.ok(third.agentId);
});
