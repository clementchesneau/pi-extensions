import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import { visibleWidth } from '@earendil-works/pi-tui';
import { createSubagentTools } from '../packages/subagents/tools.js';

test('registers seven strict provider-independent tools and rejects additional properties', () => {
  const tools = createSubagentTools({ getManager: () => ({}) });
  assert.deepEqual(
    tools.map(tool => tool.name),
    [
      'subagent_start',
      'subagent_send',
      'subagent_list',
      'subagent_result',
      'subagent_wait',
      'subagent_stop',
      'subagent_models',
    ],
  );
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object');
    assert.ok(tool.description);
    assert.ok(tool.promptGuidelines.every(guideline => guideline.includes(tool.name)));
  }
  assert.equal(Check(tools[0].parameters, { title: 'Inspect', task: 'inspect tests', context: 'only tests' }), true);
  assert.equal(Check(tools[0].parameters, { title: 'Inspect', task: 'inspect', context: '', unknown: true }), false);
  assert.equal(Check(tools[2].parameters, { agentId: 'agent', cursor: 10, limit: 5 }), true);
  assert.equal(
    Check(tools[4].parameters, { agentIds: ['agent'], runIds: ['run'], mode: 'any', timeoutMs: 1000 }),
    true,
  );
  assert.equal(Check(tools[4].parameters, { agentIds: 'agent' }), false);
});

test('guidelines make waiting optional but require reading evidence before dependent conclusions', () => {
  const tools = createSubagentTools({ getManager: () => ({}) });
  const guidelines = name => tools.find(tool => tool.name === name).promptGuidelines.join(' ');
  const start = guidelines('subagent_start');
  assert.match(start, /continue independent work/i);
  assert.match(start, /notifications.*resume/i);
  assert.doesNotMatch(start, /use subagent_wait before conclusions/i);
  const wait = guidelines('subagent_wait');
  assert.match(wait, /optional/i);
  assert.match(wait, /blocked.*still.active dependency/i);
  assert.match(wait, /group/i);
  assert.match(wait, /do not wait.*already.finished/i);
  assert.match(wait, /cancellation or timeout never kills/i);
  const result = guidelines('subagent_result');
  assert.match(result, /always read.*before.*conclusion/i);
  assert.match(result, /exact agent and run identifiers/i);
  assert.match(result, /unverified evidence/i);
});

test('start records whether each capability was inherited or explicitly specified', async () => {
  const starts = [];
  const tools = createSubagentTools({
    getManager: () => ({
      start: async input => {
        starts.push(input);
        return { agentId: 'agent', runId: 'run' };
      },
    }),
  });
  const start = tools.find(tool => tool.name === 'subagent_start');
  await start.execute('call-1', { title: 'Inherited', task: 'work', context: '' });
  await start.execute('call-2', {
    title: 'Explicit',
    task: 'work',
    context: '',
    modelId: 'model',
    thinkingLevel: 'low',
    tools: [],
  });
  assert.deepEqual(
    starts.map(({ selectionSource }) => selectionSource),
    [
      { model: 'hérité', reasoning: 'hérité', tools: 'hérités' },
      { model: 'défini', reasoning: 'défini', tools: 'définis' },
    ],
  );
});

test('delegation guideline respects explicit user preferences and avoids speculative model choices', () => {
  const guideline = createSubagentTools({ getManager: () => ({}) })[0].promptGuidelines.join(' ');
  assert.match(guideline, /explicit user.*model.*reasoning.*tools/i);
  assert.match(guideline, /consult subagent_models.*task/i);
  assert.match(guideline, /consult subagent_models/i);
  assert.match(guideline, /available model/i);
});

test('tool result cards explain acceptance, waiting and retrieval without dumping model JSON', () => {
  const tools = createSubagentTools({ getManager: () => ({}) });
  const theme = { fg: (_color, text) => text };
  const send = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ agentId: 'agent-12345678', runId: 'run-abcdef12', state: 'running', continued: true }),
      },
    ],
    details: { agentId: 'agent-12345678', runId: 'run-abcdef12', state: 'running', continued: true },
  };
  const wait = {
    content: [{ type: 'text', text: 'RAW_WAIT_JSON_' + 'x'.repeat(3000) }],
    details: [
      {
        runId: 'run-abcdef12',
        state: 'completed',
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:00:20Z',
        usage: { totalTokens: 9000 },
      },
    ],
  };
  const result = {
    content: [{ type: 'text', text: 'RAW_RESULT_JSON_' + 'x'.repeat(3000) }],
    details: {
      runId: 'run-abcdef12',
      state: 'completed',
      text: 'Child evidence: ' + 'y'.repeat(3000),
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:20Z',
    },
  };
  const rendered = (name, value, args) =>
    tools
      .find(tool => tool.name === name)
      .renderResult(value, { expanded: false }, theme, { args })
      .render(40);
  const sendLines = rendered('subagent_send', send, { agentId: 'agent-12345678' });
  assert.match(sendLines.join(' '), /continuation started/);
  assert.doesNotMatch(sendLines.join(' '), /RAW|\{"agentId"/);
  const waitLines = rendered('subagent_wait', wait, { agentIds: ['agent-12345678'] });
  assert.match(waitLines.join(' '), /completed.*20s/);
  assert.doesNotMatch(waitLines.join(' '), /RAW_WAIT_JSON|9000/);
  const resultLines = rendered('subagent_result', result, { agentId: 'agent-12345678' });
  assert.match(resultLines.join(' '), /Child evidence/);
  assert.match(resultLines.join(' '), /20s/);
  assert.doesNotMatch(
    resultLines.join(' '),
    /RAW_RESULT_JSON|yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy/,
  );
  assert.ok([...sendLines, ...waitLines, ...resultLines].every(line => visibleWidth(line) <= 40));
  assert.match(result.content[0].text, /RAW_RESULT_JSON_/, 'presentation must not alter the model result');
  const list = tools
    .find(tool => tool.name === 'subagent_list')
    .renderResult(
      {
        content: [{ type: 'text', text: 'JSON_FOR_MODEL' }],
        details: { items: Array.from({ length: 50 }, () => ({})), nextCursor: 50 },
      },
      { expanded: false },
      theme,
      { args: {} },
    )
    .render(80)
    .join(' ');
  assert.match(list, /50 shown/);
  assert.match(list, /more available/);
  assert.doesNotMatch(list, /50 subagent\(s\)/);
});

test('reading a completed run records its identity without changing model-visible output', async () => {
  const seen = [];
  const result = { runId: 'run-1', state: 'completed', text: 'EVIDENCE' };
  const tools = createSubagentTools({
    getManager: () => ({ result: async () => result }),
    onResultRead: identity => seen.push(identity),
  });
  const output = await tools
    .find(tool => tool.name === 'subagent_result')
    .execute('id', { agentId: 'agent-1', runId: 'run-1' });
  assert.deepEqual(seen, [{ agentId: 'agent-1', runId: 'run-1' }]);
  assert.equal(output.content[0].text, JSON.stringify(result));
  assert.equal(output.details.agentId, 'agent-1');
  assert.equal(output.details.runId, 'run-1');
});

test('an aborted start during capability capture never reaches admission', async () => {
  let release;
  const captured = new Promise(resolve => {
    release = resolve;
  });
  let starts = 0;
  const tools = createSubagentTools({
    getManager: () => ({
      start: async () => {
        starts += 1;
      },
    }),
    capture: async () => {
      await captured;
      return {};
    },
  });
  const controller = new AbortController();
  const pending = tools[0].execute('id', { title: 'Task', task: 'work', context: '' }, controller.signal);
  controller.abort();
  release();
  await assert.rejects(pending, /abort/i);
  assert.equal(starts, 0);
});

test('adapts start, send, result, wait and selective stop through the session manager', async () => {
  const calls = [];
  const manager = {
    start: async value => {
      calls.push(['start', value]);
      return { agentId: 'agent', alias: 'A1', runId: 'run', state: 'running' };
    },
    getAgent: () => ({ run: { state: 'running' } }),
    assertCurrentBranch: () => {},
    send: async value => {
      calls.push(['send', value]);
      return { runId: 'run-2', continued: true };
    },
    list: value => {
      calls.push(['list', value]);
      return { items: [] };
    },
    result: value => {
      calls.push(['result', value]);
      return { result: 'done' };
    },
    wait: async value => {
      calls.push(['wait', value]);
      return [];
    },
    stop: async value => {
      calls.push(['stop', value]);
      return { state: 'cancelled' };
    },
  };
  const tools = createSubagentTools({
    getManager: () => manager,
    capture: async (_ctx, input) => ({ capabilitySnapshot: { captured: true }, ...input }),
  });
  const context = { signal: new AbortController().signal };
  assert.match(
    (await tools[0].execute('id', { title: 'Task', task: 'do it', context: 'selected' }, undefined, undefined, context))
      .content[0].text,
    /A1/,
  );
  await tools[1].execute('id', { agentId: 'agent', message: 'more' }, undefined, undefined, context);
  await tools[2].execute('id', { agentId: 'agent', cursor: 10, limit: 5 }, undefined, undefined, context);
  await tools[3].execute('id', { agentId: 'agent', runId: 'run' }, undefined, undefined, context);
  await tools[4].execute(
    'id',
    { agentIds: ['agent'], runIds: ['run'], mode: 'all', timeoutMs: 1000 },
    undefined,
    undefined,
    context,
  );
  await tools[5].execute('id', { agentId: 'agent' }, undefined, undefined, context);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['start', 'send', 'list', 'result', 'wait', 'stop'],
  );
  assert.equal(calls[0][1].capabilitySnapshot.captured, true);
  assert.deepEqual(calls[2][1], { agentId: 'agent', cursor: 10, limit: 5 });
  assert.deepEqual(calls[4][1].runIds, ['run']);
});
