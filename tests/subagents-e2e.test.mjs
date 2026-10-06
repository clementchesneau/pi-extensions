import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RpcClient, SessionManager } from '@earendil-works/pi-coding-agent';
import { cli } from './fixtures/subagents/host-runtime.mjs';
import subagentsExtension from '../packages/subagents/index.js';
import * as parentSdk from '@earendil-works/pi-coding-agent';
import { createFakePi } from './fixtures/fake-pi.mjs';
parentSdk.initTheme('dark');

const here = dirname(fileURLToPath(import.meta.url));
const provider = join(here, 'fixtures/subagents/deterministic-provider.js');
const packageRoot = join(here, '..');

// Isolated, the deterministic child work takes seconds; the parallel full suite triples that.
async function until(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for deterministic child work');
}

test('a real Pi child can be stopped after writing without reverting its file or stopping its sibling', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagents-selective-stop-'));
  const home = join(root, 'home');
  const agentDir = join(root, 'agent');
  const output = join(root, 'written-by-child.txt');
  await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const messages = JSON.stringify(payload.messages);
    const child = messages.includes('Delegated mission');
    const writer = child && messages.includes('WRITE_AND_WAIT');
    const wrote = writer && payload.messages.some(message => message.role === 'tool');
    if (wrote) {
      // Only the stop may release this request; the safety delay merely avoids a hung suite.
      await new Promise(resolve => {
        const done = () => {
          clearTimeout(timer);
          response.off('close', done);
          resolve();
        };
        const timer = setTimeout(done, 60_000);
        response.once('close', done);
      });
      if (response.destroyed) return;
    }
    if (child && !writer) await new Promise(resolve => setTimeout(resolve, 2_000));
    const launch =
      !child && messages.includes('WRITE_DELEGATE') && !payload.messages.some(message => message.role === 'tool');
    const acceptedWriter = payload.messages.find(
      message => message.role === 'tool' && message.tool_call_id === 'writer',
    );
    const stopWriter =
      !child &&
      acceptedWriter &&
      !payload.messages.some(message => message.role === 'tool' && message.tool_call_id === 'stop-writer');
    if (stopWriter)
      await until(async () =>
        stat(output).then(
          () => true,
          () => false,
        ),
      );
    const delta = launch
      ? {
          role: 'assistant',
          tool_calls: ['writer', 'sibling'].map((name, index) => ({
            index,
            id: name,
            type: 'function',
            function: {
              name: 'subagent_start',
              arguments: JSON.stringify({
                title: name,
                task: name === 'writer' ? 'WRITE_AND_WAIT' : 'SIBLING_WAIT',
                context: 'isolated fixture',
              }),
            },
          })),
        }
      : stopWriter
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'stop-writer',
                type: 'function',
                function: {
                  name: 'subagent_stop',
                  arguments: JSON.stringify({ agentId: JSON.parse(acceptedWriter.content).agentId }),
                },
              },
            ],
          }
        : writer && !wrote
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'write-file',
                  type: 'function',
                  function: {
                    name: 'write',
                    arguments: JSON.stringify({ path: output, content: 'persisted after stop' }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: child ? 'SIBLING_OR_WRITER_RESULT' : 'PARENT_STILL_ACTIVE' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      `data: ${JSON.stringify({ id: 'stop-demo', object: 'chat.completion.chunk', created: 1, model: 'deterministic', choices: [{ index: 0, delta, finish_reason: launch || stopWriter || (writer && !wrote) ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    SUBAGENT_TEST_PROVIDER_URL: `http://127.0.0.1:${server.address().port}/v1`,
  };
  const args = [
    '--offline',
    '--no-extensions',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '-e',
    provider,
    '-e',
    join(packageRoot, 'packages/subagents/index.js'),
    '--model',
    'subagent-test/deterministic',
  ];
  const client = new RpcClient({ cliPath: cli, cwd: root, env, args });
  t.after(() => client.stop());
  await client.start();
  const readAgents = async () => {
    const sessions = await readdir(join(agentDir, 'subagents')).catch(() => []);
    if (!sessions.length) return [];
    const ids = await readdir(join(agentDir, 'subagents', sessions[0]));
    return Promise.all(
      ids
        .filter(name => name.includes('-'))
        .map(
          async id =>
            JSON.parse(await readFile(join(agentDir, 'subagents', sessions[0], id, 'metadata.json'), 'utf8')).agent,
        ),
    );
  };
  const launched = client.prompt('WRITE_DELEGATE');
  try {
    await until(async () =>
      stat(output).then(
        () => true,
        () => false,
      ),
    );
  } catch (error) {
    throw new Error(`${error.message}; child states: ${JSON.stringify(await readAgents())}`, { cause: error });
  }
  assert.equal(await readFile(output, 'utf8'), 'persisted after stop');
  await launched;
  const state = await until(async () => {
    const agents = await readAgents();
    return agents.length === 2 && agents.every(agent => ['completed', 'cancelled'].includes(agent.runs.at(-1).state))
      ? agents
      : undefined;
  });
  // Both starts run concurrently: aliases follow admission order, not call order.
  const writer = state.find(agent => agent.title === 'writer');
  const sibling = state.find(agent => agent.title === 'sibling');
  assert.equal(writer.runs.at(-1).state, 'cancelled');
  assert.equal(sibling.runs.at(-1).state, 'completed');
  assert.equal(await readFile(output, 'utf8'), 'persisted after stop');
  const parentState = await client.getState();
  assert.ok(parentState.sessionId);

  // Reopen the real parent's archived session through the extension's TUI entry point.
  // The widget and detail must read the persisted worker states, not fixture-only view objects.
  const widgets = new Map();
  let component;
  const fake = createFakePi();
  subagentsExtension(fake.pi, {
    sdk: parentSdk,
    agentDir,
    configPath: join(home, '.config/pi-extensions/subagents.json'),
    createRuntime: async () => {
      throw new Error('viewing archives must not start a worker');
    },
  });
  const ctx = {
    mode: 'tui',
    hasUI: true,
    cwd: root,
    sessionManager: SessionManager.open(parentState.sessionFile, undefined, root),
    ui: {
      notify() {},
      setWidget: (id, widget) => (widget ? widgets.set(id, widget) : widgets.delete(id)),
      custom: factory =>
        new Promise(resolve => {
          component = factory({ requestRender() {} }, { fg: (_name, text) => text }, { matches: () => false }, resolve);
        }),
    },
  };
  await fake.fire('session_start', {}, ctx);
  assert.equal(widgets.has('subagents-status'), false, 'archived missions must not keep the status widget visible');
  const opened = fake.commands.get('subagents').handler('', ctx);
  const selected = () => component.render(120).find(line => line.includes('→')) ?? '';
  if (!selected().includes(sibling.alias)) component.handleInput('\x1b[B');
  assert.ok(selected().includes(sibling.alias));
  component.handleInput('\r');
  const detailText = await until(() => {
    const text = component.render(120).join(' ');
    return text.includes('SIBLING_OR_WRITER_RESULT') ? text : undefined;
  });
  assert.match(detailText, /Latest run · verify/);
  assert.match(detailText, /completed/);
  assert.doesNotMatch(detailText, /completed · \d+s/);
  component.handleInput('i');
  let information = '';
  for (let i = 0; i < 30; i++) {
    information += component.render(120).join(' ');
    component.handleInput('\x1b[B');
  }
  assert.match(information, /Total duration: \d+s/);
  assert.match(information, /Run 1/);
  assert.match(information, /Initial mission.*SIBLING_WAIT/);
  assert.match(information, /Initial mission above/);
  assert.match(information, /tokens/);
  assert.doesNotMatch(information, /SIBLING_OR_WRITER_RESULT/);
  component.handleInput('a');
  const activity = await until(() => {
    component.handleInput('\x1b[B');
    const text = component.render(120).join(' ');
    return text.includes('SIBLING_OR_WRITER_RESULT') ? text : undefined;
  });
  assert.match(activity, /SIBLING_OR_WRITER_RESULT/);
  assert.doesNotMatch(activity, /Agent ·|Parent ·/);
  await fake.fire('session_shutdown', {}, ctx);
  await opened;
  assert.equal(widgets.has('subagents-status'), false);
});

test('real Pi package loads inherited extensions in manifest order before delegating', async t => {
  const root = await mkdtemp(join(tmpdir(), 'subagents-package-e2e-'));
  const home = join(root, 'home');
  const agentDir = join(root, 'agent');
  await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const messages = JSON.stringify(payload.messages);
    const isChild = messages.includes('Delegated mission');
    const hasResults = messages.includes('Result available (unverified)');
    const launch =
      !isChild && messages.includes('PACKAGE_DELEGATE') && !payload.messages.some(message => message.role === 'tool');
    const inspect =
      !isChild &&
      hasResults &&
      !payload.messages.some(message => message.role === 'tool' && message.tool_call_id === 'inspect');
    const accepted = payload.messages.find(message => message.role === 'tool' && message.tool_call_id === 'delegate');
    const identity = accepted ? JSON.parse(accepted.content) : undefined;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = launch
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'delegate',
              type: 'function',
              function: {
                name: 'subagent_start',
                arguments: JSON.stringify({ title: 'Package', task: 'read evidence', context: 'selected context' }),
              },
            },
          ],
        }
      : inspect && identity
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'inspect',
                type: 'function',
                function: {
                  name: 'subagent_result',
                  arguments: JSON.stringify({ agentId: identity.agentId, runId: identity.runId }),
                },
              },
            ],
          }
        : {
            role: 'assistant',
            content: isChild
              ? 'CHILD_PACKAGE_EVIDENCE'
              : messages.includes('CHILD_PACKAGE_EVIDENCE')
                ? 'PARENT_USED_PACKAGE_EVIDENCE'
                : 'PROVISIONAL',
          };
    response.write(
      `data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model: 'deterministic', choices: [{ index: 0, delta, finish_reason: launch || (inspect && identity) ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    SUBAGENT_TEST_PROVIDER_URL: `http://127.0.0.1:${server.address().port}/v1`,
  };
  const args = [
    cli,
    '--offline',
    '--no-extensions',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '-e',
    packageRoot,
    '-e',
    provider,
    '--model',
    'subagent-test/deterministic',
    '--mode',
    'json',
    '--print',
    'PACKAGE_DELEGATE',
  ];
  const processChild = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let stderr = '';
  processChild.stdout.on('data', chunk => {
    output += chunk;
  });
  processChild.stderr.on('data', chunk => {
    stderr += chunk;
  });
  let timer;
  const exit = await Promise.race([
    new Promise(resolve => processChild.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        processChild.kill('SIGKILL');
        reject(new Error(`Pi package test timed out: ${stderr}`));
      }, 25_000);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(exit.code, 0, stderr);
  const events = output
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const launch = events.find(event => event.type === 'tool_execution_end' && event.toolName === 'subagent_start');
  assert.ok(launch && !launch.isError, `${JSON.stringify(launch?.result?.content)}\n${stderr}`);
  assert.equal(
    events.filter(
      event =>
        event.type === 'entry_appended' &&
        event.entry?.customType === 'subagents-event-v1' &&
        event.entry?.data?.state === 'lancement accepté',
    ).length,
    0,
    'the tool acceptance must not be repeated as another conversation event',
  );
  const id = JSON.parse(launch.result.content[0].text).agentId;
  const sessionIds = await readdir(join(agentDir, 'subagents'));
  assert.equal(sessionIds.length, 1);
  const sessionId = sessionIds[0];
  const metadata = JSON.parse(await readFile(join(agentDir, 'subagents', sessionId, id, 'metadata.json'), 'utf8'));
  const inherited = metadata.agent.capabilitySnapshot.extensionPaths;
  const expected = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).pi.extensions;
  const positions = inherited.map(path => expected.findIndex(relative => path === join(packageRoot, relative)));
  assert.ok(inherited.length >= 2 && positions.every(position => position >= 0), JSON.stringify(inherited));
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
  assert.ok(requests.some(payload => JSON.stringify(payload.messages).includes('selected context')));
  assert.ok(
    requests.some(payload =>
      payload.messages.some(
        message =>
          message.role === 'tool' &&
          message.tool_call_id === 'inspect' &&
          message.content.includes('CHILD_PACKAGE_EVIDENCE'),
      ),
    ),
  );
  assert.ok(
    events.some(
      event =>
        event.type === 'message_end' &&
        event.message?.content?.some?.(block => block.text === 'PARENT_USED_PACKAGE_EVIDENCE'),
    ),
  );
});
