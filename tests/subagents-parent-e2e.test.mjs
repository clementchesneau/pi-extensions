import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli } from './fixtures/subagents/host-runtime.mjs';
import test from 'node:test';
import { copyPublishedPackage } from './fixtures/published-package.mjs';
import { RpcClient } from '@earendil-works/pi-coding-agent';

const here = dirname(fileURLToPath(import.meta.url));
const provider = join(here, 'fixtures/subagents/deterministic-provider.js');
const childDialog = join(here, 'fixtures/subagents/child-dialog.js');
const barrierObserver = join(here, 'fixtures/subagents/barrier-observer.js');

async function fixture(
  t,
  {
    autoDelegate = true,
    delayChild = 150,
    childTask = 'return evidence',
    twoMissions = false,
    slowIncomplete = false,
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'subagent-parent-e2e-'));
  const home = join(root, 'home');
  await mkdir(home);
  // Production-like extension: host peers absent, with spaces and a symlink.
  const packageRoot = join(root, 'production package');
  await copyPublishedPackage('subagents', packageRoot);
  const linkedPackage = join(root, 'linked package');
  await symlink(packageRoot, linkedPackage);
  const isolatedExtension = join(linkedPackage, 'index.js');
  const config = join(home, '.config/pi-extensions/subagents.json');
  await mkdir(dirname(config), { recursive: true });
  await writeFile(config, `${JSON.stringify({ version: 1, autoDelegate, maxConcurrent: 4 })}\n`);
  const requests = [];
  let completedChildren = 0;
  const settledOrder = [];
  let resumeTarget;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const messages = JSON.stringify(payload.messages);
    if (messages.includes('Delegated mission') && !messages.includes('INSPECT_RESTORED')) {
      await new Promise(resolve =>
        setTimeout(resolve, twoMissions && messages.includes('slow evidence') ? 350 : twoMissions ? 30 : delayChild),
      );
      completedChildren += 1;
      settledOrder.push(
        messages.includes('slow evidence') ? 'slow' : messages.includes('fast evidence') ? 'fast' : 'single',
      );
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finishReason) =>
      response.write(
        `data: ${JSON.stringify({
          id: `response-${requests.length}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deterministic',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    if (messages.includes('Follow-up on the previous delegated work:')) {
      send({ role: 'assistant', content: 'CONTINUED_CHILD_EVIDENCE' }, 'stop');
    } else if (
      messages.includes('RESUME_CONTINUE') &&
      payload.messages.some(message => message.role === 'tool' && message.tool_call_id === 'resume')
    ) {
      send({ role: 'assistant', content: 'CONTINUATION_ACCEPTED' }, 'stop');
    } else if (messages.includes('RESUME_CONTINUE') && resumeTarget) {
      send(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'resume',
              type: 'function',
              function: {
                name: 'subagent_send',
                arguments: JSON.stringify({ agentId: resumeTarget.agentId, message: 'continue earlier evidence' }),
              },
            },
          ],
        },
        'tool_calls',
      );
    } else if (
      messages.includes('INSPECT_RESTORED') &&
      payload.messages.some(message => message.role === 'tool' && message.tool_call_id === 'inspect')
    ) {
      send({ role: 'assistant', content: 'RESTORED_RESULT_SEEN' }, 'stop');
    } else if (messages.includes('INSPECT_RESTORED') && resumeTarget) {
      send(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'inspect',
              type: 'function',
              function: { name: 'subagent_result', arguments: JSON.stringify(resumeTarget) },
            },
          ],
        },
        'tool_calls',
      );
    } else if (messages.includes('Delegated mission'))
      send(
        {
          role: 'assistant',
          content:
            twoMissions && messages.includes('slow evidence')
              ? 'SLOW_EVIDENCE'
              : twoMissions
                ? 'FAST_EVIDENCE'
                : 'CHILD_EVIDENCE',
        },
        slowIncomplete && messages.includes('slow evidence') ? 'length' : 'stop',
      );
    else if (messages.includes('Result available (unverified)'))
      send({ role: 'assistant', content: 'FINAL_WITH_CHILD_EVIDENCE' }, 'stop');
    else if (payload.messages.some(message => message.role === 'tool'))
      send({ role: 'assistant', content: 'PROVISIONAL' }, 'stop');
    else if (messages.includes('DELEGATE_NOW')) {
      if (twoMissions) {
        send(
          {
            role: 'assistant',
            tool_calls: ['slow', 'fast'].map((name, index) => ({
              index,
              id: name,
              type: 'function',
              function: {
                name: 'subagent_start',
                arguments: JSON.stringify({ title: name, task: `${name} evidence`, context: 'selected only' }),
              },
            })),
          },
          'tool_calls',
        );
      } else {
        send(
          {
            role: 'assistant',
            tool_calls: [
              { index: 0, id: 'delegate', type: 'function', function: { name: 'subagent_start', arguments: '' } },
            ],
          },
          null,
        );
        send(
          {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: JSON.stringify({ title: 'Evidence', task: childTask, context: 'selected only' }),
                },
              },
            ],
          },
          'tool_calls',
        );
      }
    } else send({ role: 'assistant', content: 'IDLE' }, 'stop');
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: join(root, 'agent'),
    PI_OFFLINE: '1',
    SUBAGENT_TEST_PROVIDER_URL: `http://127.0.0.1:${server.address().port}/v1`,
  };
  const args = [
    '--no-extensions',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--session-dir',
    join(root, 'sessions'),
    '-e',
    provider,
    '-e',
    isolatedExtension,
    '--model',
    'subagent-test/deterministic',
  ];
  return {
    root,
    env,
    args,
    extension: isolatedExtension,
    requests,
    settledOrder,
    get completedChildren() {
      return completedChildren;
    },
    setResumeTarget(value) {
      resumeTarget = value;
    },
    config,
  };
}

async function printRun({ root, env, args }, mode) {
  const child = spawn(process.execPath, [cli, ...args, '--mode', mode, '--print', 'DELEGATE_NOW'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  let timer;
  const exit = await Promise.race([
    new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('parent print/JSON timed out'));
      }, 20_000);
    }),
  ]).finally(() => clearTimeout(timer));
  return { ...exit, stdout, stderr };
}

for (const mode of ['text', 'json']) {
  test(`real Pi ${mode} print waits for a child and includes the delivered result in the final turn`, async t => {
    const setup = await fixture(t);
    const output = await printRun(setup, mode);
    assert.equal(output.code, 0, output.stderr);
    assert.equal(setup.completedChildren, 1);
    assert.match(output.stdout, /FINAL_WITH_CHILD_EVIDENCE/);
    assert.ok(
      setup.requests.some(payload => JSON.stringify(payload.messages).includes('Result available (unverified)')),
    );
    if (mode === 'json') {
      const events = output.stdout
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      assert.ok(events.some(event => event.type === 'agent_settled'));
      const notice = events.find(
        event => event.type === 'message_end' && event.message?.customType === 'subagents-result-v1',
      );
      assert.match(notice?.message?.details?.preview ?? '', /CHILD_EVIDENCE/);
      assert.doesNotMatch(notice.message.content, /CHILD_EVIDENCE/);
    }
  });
}

test('real JSON print parent waits for two children that finish in reverse order', async t => {
  const setup = await fixture(t, { twoMissions: true });
  const output = await printRun(setup, 'json');
  assert.equal(output.code, 0, output.stderr);
  assert.deepEqual(setup.settledOrder, ['fast', 'slow']);
  const events = output.stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const started = events.filter(event => event.type === 'tool_execution_end' && event.toolName === 'subagent_start');
  assert.equal(started.length, 2);
  const delivered = events.filter(
    event => event.type === 'message_end' && event.message?.customType === 'subagents-result-v1',
  );
  assert.equal(new Set(delivered.map(event => event.message.details.runId)).size, 2);
  assert.ok(
    events.some(
      event =>
        event.type === 'message_end' &&
        event.message?.content?.some?.(block => block.text === 'FINAL_WITH_CHILD_EVIDENCE'),
    ),
  );
});

test('real JSON print parent reports an incomplete child separately from its completed sibling', async t => {
  const setup = await fixture(t, { twoMissions: true, slowIncomplete: true });
  const output = await printRun(setup, 'json');
  assert.equal(output.code, 0, output.stderr);
  const events = output.stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const delivered = events.filter(
    event => event.type === 'message_end' && event.message?.customType === 'subagents-result-v1',
  );
  assert.deepEqual(delivered.map(event => event.message.details.state).sort(), ['completed', 'failed']);
  assert.equal(new Set(delivered.map(event => event.message.details.runId)).size, 2);
});

for (const mode of ['text', 'json']) {
  test(`real Pi ${mode} print releases a pending child when its parent receives SIGTERM`, async t => {
    const setup = await fixture(t, { delayChild: 8_000 });
    const marker = join(setup.root, 'parent-entered-agent-end');
    const args = [...setup.args];
    args.splice(args.indexOf(setup.extension) - 1, 0, '-e', barrierObserver);
    const child = spawn(process.execPath, [cli, ...args, '--mode', mode, '--print', 'DELEGATE_NOW'], {
      cwd: setup.root,
      env: { ...setup.env, SUBAGENT_TEST_BARRIER_MARKER: marker },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const parentReplied = setup.requests.some(payload =>
        payload.messages.some(message => message.role === 'tool' && message.tool_call_id === 'delegate'),
      );
      const childStarted = setup.requests.some(payload =>
        JSON.stringify(payload.messages).includes('Delegated mission'),
      );
      const finalTurn =
        mode === 'json' &&
        stdout.split('\n').some(line => {
          try {
            const event = JSON.parse(line);
            return event.type === 'turn_end' && event.message?.content?.some(block => block.text === 'PROVISIONAL');
          } catch {
            return false;
          }
        });
      const enteredBarrier = await readFile(marker, 'utf8').then(
        text => text === 'entered',
        () => false,
      );
      if (parentReplied && childStarted && enteredBarrier && (mode === 'text' || finalTurn)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(
      setup.requests.some(payload =>
        payload.messages.some(message => message.role === 'tool' && message.tool_call_id === 'delegate'),
      ),
      stderr,
    );
    assert.ok(
      setup.requests.some(payload => JSON.stringify(payload.messages).includes('Delegated mission')),
      stderr,
    );
    assert.equal(await readFile(marker, 'utf8'), 'entered', 'real parent must enter agent_end before the signal');
    if (mode === 'json')
      assert.ok(
        stdout.split('\n').some(line => {
          try {
            const event = JSON.parse(line);
            return event.type === 'turn_end' && event.message?.content?.some(block => block.text === 'PROVISIONAL');
          } catch {
            return false;
          }
        }),
        'the provisional parent turn must finish before the signal',
      );
    assert.equal(setup.completedChildren, 0, 'the child must still be pending at cancellation');
    assert.equal(child.exitCode, null, 'parent must still be held by its active child');
    assert.equal(child.kill('SIGTERM'), true);
    let timeout;
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`parent failed to release its barrier: ${stderr}`)), 5_000);
      }),
    ]).finally(() => clearTimeout(timeout));
    assert.deepEqual(result, { code: 143, signal: null }, stderr);
    assert.doesNotMatch(stdout, /FINAL_WITH_CHILD_EVIDENCE/);
    assert.equal(setup.completedChildren, 0);
    const sessions = await readdir(join(setup.env.PI_CODING_AGENT_DIR, 'subagents'));
    assert.equal(sessions.length, 1);
    const agents = await readdir(join(setup.env.PI_CODING_AGENT_DIR, 'subagents', sessions[0]));
    assert.equal(agents.length, 1);
    const archived = JSON.parse(
      await readFile(join(setup.env.PI_CODING_AGENT_DIR, 'subagents', sessions[0], agents[0], 'metadata.json'), 'utf8'),
    );
    assert.equal(archived.agent.runs.at(-1).state, 'cancelled');
    assert.equal('piRuntime' in archived.agent, false);
    assert.equal('piRuntime' in archived.agent.capabilitySnapshot, false);
  });
}

test('real RPC session replacement stops ownership and resume restores archived results without relaunch', async t => {
  const setup = await fixture(t);
  const client = new RpcClient({ cliPath: cli, cwd: setup.root, env: setup.env, args: setup.args });
  t.after(() => client.stop());
  await client.start();
  const events = await client.promptAndWait('DELEGATE_NOW', undefined, 20_000);
  assert.ok(
    events.some(
      event =>
        event.type === 'message_end' &&
        event.message?.content?.some?.(block => block.text === 'FINAL_WITH_CHILD_EVIDENCE'),
    ),
  );
  const original = (await client.getState()).sessionFile;
  const oldEntries = (await client.getEntries()).entries;
  assert.ok(oldEntries.some(entry => entry.type === 'custom' && entry.customType === 'subagents-state-v1'));
  assert.equal((await client.newSession()).cancelled, false);
  assert.equal(
    (await client.getEntries()).entries.some(
      entry => entry.type === 'custom' && entry.customType === 'subagents-state-v1',
    ),
    false,
  );
  assert.equal((await client.switchSession(original)).cancelled, false);
  const restored = (await client.getEntries()).entries;
  assert.ok(restored.some(entry => entry.type === 'custom' && entry.customType === 'subagents-state-v1'));
  assert.equal(setup.completedChildren, 1);
  const resultMessage = restored.find(
    entry => entry.type === 'custom_message' && entry.customType === 'subagents-result-v1',
  );
  assert.ok(resultMessage);
  assert.match(resultMessage.details.preview, /CHILD_EVIDENCE/);
  setup.setResumeTarget({ agentId: resultMessage.details.agentId, runId: resultMessage.details.runId });
  const restoredSessionId = (await client.getState()).sessionId;
  const agentFolders = await readdir(join(setup.env.PI_CODING_AGENT_DIR, 'subagents', restoredSessionId)).catch(
    () => [],
  );
  assert.ok(agentFolders.includes(resultMessage.details.agentId), JSON.stringify({ restoredSessionId, agentFolders }));
  const inspected = await client.promptAndWait('INSPECT_RESTORED', undefined, 20_000);
  assert.ok(
    inspected.some(
      event =>
        event.type === 'message_end' && event.message?.content?.some?.(block => block.text === 'RESTORED_RESULT_SEEN'),
    ),
    JSON.stringify(inspected.filter(event => event.type === 'message_end').map(event => event.message?.content)),
  );
  assert.ok(
    setup.requests.some(payload =>
      payload.messages.some(
        message =>
          message.role === 'tool' && message.tool_call_id === 'inspect' && message.content.includes('CHILD_EVIDENCE'),
      ),
    ),
    JSON.stringify(
      setup.requests.flatMap(payload =>
        payload.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'inspect'),
      ),
    ),
  );
  assert.equal(setup.completedChildren, 1);
  const continued = await client.promptAndWait('RESUME_CONTINUE', undefined, 20_000);
  assert.ok(
    continued.some(
      event => event.type === 'tool_execution_end' && event.toolName === 'subagent_send' && !event.isError,
    ),
    JSON.stringify(
      continued
        .filter(event => event.type === 'tool_execution_end')
        .map(event => ({ name: event.toolName, result: event.result?.content })),
    ),
  );
  assert.ok(
    setup.requests.some(
      payload =>
        JSON.stringify(payload.messages).includes('CHILD_EVIDENCE') &&
        JSON.stringify(payload.messages).includes('continue earlier evidence'),
    ),
  );
  const continuation = continued.find(
    event => event.type === 'tool_execution_end' && event.toolName === 'subagent_send',
  );
  const runId = JSON.parse(continuation.result.content[0].text).runId;
  const continuedText = await readFile(
    join(
      setup.env.PI_CODING_AGENT_DIR,
      'subagents',
      restoredSessionId,
      resultMessage.details.agentId,
      `result-${runId}.txt`,
    ),
    'utf8',
  );
  assert.equal(continuedText, 'CONTINUED_CHILD_EVIDENCE');
});

test('real RPC clone treats copied subagent records as archives, not active handles', async t => {
  const setup = await fixture(t);
  const client = new RpcClient({ cliPath: cli, cwd: setup.root, env: setup.env, args: setup.args });
  t.after(() => client.stop());
  await client.start();
  await client.promptAndWait('DELEGATE_NOW', undefined, 20_000);
  const oldSessionId = (await client.getState()).sessionId;
  const original = (await client.getEntries()).entries.find(entry => entry.customType === 'subagents-result-v1');
  assert.ok(original);
  setup.setResumeTarget({ agentId: original.details.agentId, runId: original.details.runId });
  assert.equal((await client.clone()).cancelled, false);
  assert.notEqual((await client.getState()).sessionId, oldSessionId);
  const events = await client.promptAndWait('INSPECT_RESTORED', undefined, 20_000);
  assert.ok(
    events.some(
      event =>
        event.type === 'tool_execution_end' &&
        event.toolName === 'subagent_result' &&
        JSON.stringify(event.result).includes('Unknown subagent'),
    ),
  );
  assert.equal(setup.completedChildren, 1);
});

test('real RPC session replacement stops an active child and does not inject its result into the new session', async t => {
  const setup = await fixture(t, { delayChild: 4_000 });
  const client = new RpcClient({ cliPath: cli, cwd: setup.root, env: setup.env, args: setup.args });
  t.after(() => client.stop());
  await client.start();
  let resolveStarted;
  const started = new Promise(resolve => {
    resolveStarted = resolve;
  });
  client.onEvent(event => {
    if (event.type === 'tool_execution_end' && event.toolName === 'subagent_start') resolveStarted();
  });
  await client.prompt('DELEGATE_NOW');
  let timer;
  await Promise.race([
    started,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('child did not start')), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
  const oldSessionId = (await client.getState()).sessionId;
  assert.equal((await client.newSession()).cancelled, false);
  assert.equal(
    (await client.getEntries()).entries.some(entry => entry.customType === 'subagents-result-v1'),
    false,
  );
  const agents = await readdir(join(setup.env.PI_CODING_AGENT_DIR, 'subagents', oldSessionId));
  assert.equal(agents.length, 1);
  const archived = JSON.parse(
    await readFile(join(setup.env.PI_CODING_AGENT_DIR, 'subagents', oldSessionId, agents[0], 'metadata.json'), 'utf8'),
  );
  assert.equal(archived.agent.runs.at(-1).state, 'cancelled');
});

test('real RPC parent forwards a child confirmation dialog and returns its response', async t => {
  const setup = await fixture(t, { childTask: 'WAIT_FOR_DIALOG' });
  const client = new RpcClient({
    cliPath: cli,
    cwd: setup.root,
    env: setup.env,
    args: [...setup.args, '-e', childDialog],
  });
  t.after(() => client.stop());
  await client.start();
  const dialogs = [];
  client.onEvent(event => {
    if (event.type !== 'extension_ui_request' || event.method !== 'confirm') return;
    dialogs.push(event);
    client.process.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: event.id, confirmed: true })}\n`);
  });
  const events = await client.promptAndWait('DELEGATE_NOW', undefined, 20_000);
  assert.equal(
    dialogs.length,
    1,
    JSON.stringify(
      events
        .filter(event => ['extension_ui_request', 'tool_execution_end', 'message_end'].includes(event.type))
        .map(event => ({
          type: event.type,
          method: event.method,
          title: event.title,
          toolName: event.toolName,
          result: event.result?.content,
          content: event.message?.content,
        })),
    ),
  );
  assert.match(dialogs[0].title, /\[A1\]/);
  assert.ok(
    events.some(event => event.type === 'tool_execution_end' && event.toolName === 'subagent_start' && !event.isError),
  );
});

test('real print parent cancels a child dialog it cannot display', async t => {
  const setup = await fixture(t, { childTask: 'WAIT_FOR_DIALOG' });
  const output = await printRun({ ...setup, args: [...setup.args, '-e', childDialog] }, 'json');
  assert.equal(output.code, 0, output.stderr);
  const events = output.stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const terminal = events.filter(
    event => event.type === 'message_end' && event.message?.customType === 'subagents-result-v1',
  );
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].message.details.state, 'completed');
  assert.ok(setup.requests.some(payload => payload.messages[0]?.content.includes('CHILD_DIALOG_DECLINED')));
});

test('real RPC parent serializes a required launch confirmation and honors rejection', async t => {
  const setup = await fixture(t, { autoDelegate: false });
  const client = new RpcClient({ cliPath: cli, cwd: setup.root, env: setup.env, args: setup.args });
  t.after(() => client.stop());
  await client.start();
  const dialogs = [];
  client.onEvent(event => {
    if (event.type !== 'extension_ui_request' || event.method !== 'confirm') return;
    dialogs.push(event);
    client.process.stdin.write(
      `${JSON.stringify({ type: 'extension_ui_response', id: event.id, confirmed: false })}\n`,
    );
  });
  const events = await client.promptAndWait('DELEGATE_NOW', undefined, 20_000);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].title, /Start A1/);
  assert.ok(Number.isSafeInteger(dialogs[0].timeout) && dialogs[0].timeout > 0 && dialogs[0].timeout <= 60_000);
  assert.ok(
    events.some(
      event =>
        event.type === 'tool_execution_end' &&
        event.toolName === 'subagent_start' &&
        JSON.stringify(event.result).includes('declined'),
    ),
  );
  assert.equal(setup.completedChildren, 0);
});

test('real print parent refuses delegation when confirmation is required without a UI', async t => {
  const setup = await fixture(t, { autoDelegate: false });
  const output = await printRun(setup, 'json');
  assert.equal(output.code, 0, output.stderr);
  const events = output.stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const results = events.filter(event => event.type === 'tool_execution_end' && event.toolName === 'subagent_start');
  assert.equal(results.length, 1);
  assert.match(JSON.stringify(results[0]), /confirmation.*unavailable/i);
  assert.equal(setup.completedChildren, 0);
});
