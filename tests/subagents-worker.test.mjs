import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { copyPublishedPackage } from './fixtures/published-package.mjs';
import { piRuntime } from './fixtures/subagents/host-runtime.mjs';
import { resolveHostPiRuntime } from '../packages/subagents/pi-compatibility.js';
import { createSubagentRuntime } from '../packages/subagents/runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const providerPath = join(here, 'fixtures/subagents/deterministic-provider.js');
const orphanParentPath = join(here, 'fixtures/subagents/orphan-parent.mjs');
const blockingShutdownPath = join(here, 'fixtures/subagents/blocking-shutdown.js');
const crashWithChildrenPath = join(here, 'fixtures/subagents/crash-with-children.js');
const promisifiedChildProcessPath = join(here, 'fixtures/subagents/promisified-child-process.js');
const childrenOnStartPath = join(here, 'fixtures/subagents/children-on-start.js');
const orphanedGroupOnStartPath = join(here, 'fixtures/subagents/orphaned-group-on-start.js');
const blockingBootstrapChildPath = join(here, 'fixtures/subagents/blocking-bootstrap-child.js');
const blockingSyncShutdownPath = join(here, 'fixtures/subagents/blocking-sync-shutdown.js');
const shutdownChildPath = join(here, 'fixtures/subagents/shutdown-child.js');
const consoleValuesPath = join(here, 'fixtures/subagents/console-values.js');
const realWorkerPath = join(here, '../packages/subagents/worker.js');

async function deterministicServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const turn = requests.length;
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
    const chunk = (content, finish_reason = null, usage) =>
      response.write(
        `data: ${JSON.stringify({
          id: `completion-${turn}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deterministic',
          choices: [{ index: 0, delta: content === undefined ? {} : { role: 'assistant', content }, finish_reason }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
      );
    chunk(`answer-${turn}-a`);
    chunk('-b', 'stop', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, url: `http://127.0.0.1:${server.address().port}/v1` };
}

test('real Pi worker bootstraps privately and reuses an independent session with a local provider', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-agent-'));
  const provider = await deterministicServer();
  t.after(async () => {
    await new Promise(resolve => provider.server.close(resolve));
    await rm(agentDir, { recursive: true, force: true });
  });
  // Published layout without host packages: the copied worker must use the explicit host SDK.
  const isolatedWorker = join(agentDir, 'worker package');
  await copyPublishedPackage('subagents', isolatedWorker);
  const hostEntry = await realpath(
    process.env.PI_TEST_HOST_ENTRY ?? fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')),
  );
  const instanceId = `worker-${Date.now()}`;
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime: resolveHostPiRuntime({ entryPoint: hostEntry }),
      instanceId,
      parentSessionId: 'parent-private-id',
      cwd: process.cwd(),
      agentDir,
      model: { provider: 'subagent-test', id: 'deterministic' },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: { extensionPaths: [providerPath], skillPaths: [], promptTemplatePaths: [], contextFiles: false },
    },
    {
      workerPath: join(isolatedWorker, 'worker.js'),
      env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, PI_OFFLINE: '1' },
      startupTimeoutMs: 10_000,
      requestTimeoutMs: 5_000,
    },
  );
  t.after(() => runtime.stop());
  await runtime.start();
  assert.match(runtime.stderr, /deterministic provider loaded/);
  const first = await runtime.prompt('/literal mission');
  const firstResult = await first.result;
  assert.equal(firstResult.instanceId, instanceId);
  assert.equal(firstResult.runId, first.runId);
  assert.equal(firstResult.status, 'completed');
  assert.equal(firstResult.text, 'answer-1-a-b');
  assert.equal(firstResult.stopReason, 'stop');
  assert.equal(firstResult.usage.totalTokens, 12);
  assert.equal(firstResult.sessionStats.tokens.total, 12);
  assert.equal(provider.requests.length, 1);
  assert.match(JSON.stringify(provider.requests[0].messages), /literal mission/);
  assert.doesNotMatch(JSON.stringify(provider.requests[0].messages), /parent-private-id/);

  const second = await runtime.prompt('follow up');
  assert.equal((await second.result).text, 'answer-2-a-b');
  assert.equal(provider.requests.length, 2);
  assert.match(JSON.stringify(provider.requests[1].messages), /answer-1-a-b/);
  assert.match(JSON.stringify(provider.requests[1].messages), /follow up/);

  const handled = await runtime.prompt('HANDLE_IMMEDIATELY');
  const handledResult = await Promise.race([
    handled.result,
    new Promise((_, reject) => setTimeout(() => reject(new Error('handled input did not settle')), 500)),
  ]);
  assert.equal(handledResult.status, 'no_output');
  assert.equal(provider.requests.length, 2);
  const afterHandled = await runtime.prompt('after handled');
  assert.equal((await afterHandled.result).text, 'answer-3-a-b');

  const dialogSeen = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dialog request was not emitted')), 2_000);
    const unsubscribe = runtime.subscribe(event => {
      if (
        event.type === 'rpc_event' &&
        event.data?.type === 'extension_ui_request' &&
        event.data.method === 'confirm'
      ) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
  const waiting = runtime.prompt('WAIT_FOR_DIALOG').then(
    run => run.result,
    error => ({ status: 'rejected', error }),
  );
  await dialogSeen;
  await runtime.stop();
  assert.match((await waiting).status, /aborted|rejected/);
});

test('a worker refuses a missing SDK contract before any provider request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'missing-host-contract-'));
  const provider = await deterministicServer();
  t.after(async () => {
    provider.server.closeAllConnections();
    await new Promise(resolve => provider.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'dist'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version: piRuntime.version,
      type: 'module',
      exports: { '.': { import: './dist/index.js' } },
    }),
  );
  const entry = join(root, 'dist/index.js');
  await writeFile(
    entry,
    `export * from ${JSON.stringify(pathToFileURL(piRuntime.entry).href)};\nexport const runRpcMode = undefined;\n`,
  );
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime: resolveHostPiRuntime({ entryPoint: entry }),
      instanceId: 'missing-contract',
      cwd: process.cwd(),
      agentDir: root,
      model: { provider: 'subagent-test', id: 'deterministic' },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: { extensionPaths: [providerPath], contextFiles: false },
    },
    { env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, PI_OFFLINE: '1' } },
  );
  t.after(() => runtime.stop());
  await assert.rejects(runtime.start(), /required capability runRpcMode/);
  assert.equal(runtime.status, 'stopped');
  assert.equal(provider.requests.length, 0);
});

test('compatible runtime fixtures with different releases launch without a release gate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compatible-host-'));
  const provider = await deterministicServer();
  t.after(async () => {
    provider.server.closeAllConnections();
    await new Promise(resolve => provider.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  for (const version of ['23.4.5', '24.5.6']) {
    const directory = join(root, version);
    await mkdir(join(directory, 'dist'), { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: '@earendil-works/pi-coding-agent',
        version,
        type: 'module',
        exports: { '.': { import: './dist/index.js' } },
      }),
    );
    const entry = join(directory, 'dist/index.js');
    await writeFile(
      entry,
      `export * from ${JSON.stringify(pathToFileURL(piRuntime.entry).href)};\nexport const VERSION = ${JSON.stringify(version)};\n`,
    );
    const runtime = createSubagentRuntime(
      {
        version: 1,
        piRuntime: resolveHostPiRuntime({ entryPoint: entry }),
        instanceId: `release-${version}`,
        cwd: process.cwd(),
        agentDir: root,
        model: { provider: 'subagent-test', id: 'deterministic' },
        thinkingLevel: 'off',
        allowedTools: [],
        resources: { extensionPaths: [providerPath], contextFiles: false },
      },
      { env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, PI_OFFLINE: '1' } },
    );
    t.after(() => runtime.stop());
    await runtime.start();
    const run = await runtime.prompt('same observable contract');
    assert.equal((await run.result).status, 'completed');
    await runtime.stop();
  }
  assert.equal(provider.requests.length, 2);
});

test('a restored worker refuses a missing child transcript rather than starting an empty session', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-missing-transcript-'));
  const provider = await deterministicServer();
  const missing = join(agentDir, 'missing.jsonl');
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime,
      instanceId: `missing-${Date.now()}`,
      parentSessionId: 'parent',
      cwd: process.cwd(),
      agentDir,
      model: { provider: 'subagent-test', id: 'deterministic' },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: { extensionPaths: [providerPath], skillPaths: [], promptTemplatePaths: [], contextFiles: false },
      sessionDir: agentDir,
      sessionFile: missing,
    },
    { env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, PI_OFFLINE: '1' }, startupTimeoutMs: 10_000 },
  );
  t.after(async () => {
    await runtime.stop().catch(() => {});
    await new Promise(resolve => provider.server.close(resolve));
    await rm(agentDir, { recursive: true, force: true });
  });
  await assert.rejects(runtime.start(), /transcription.*unavailable|transcript.*missing/i);
  assert.equal(provider.requests.length, 0);
});

test('a restored worker refuses empty and header-only transcripts without prior conversation', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-empty-transcript-'));
  const provider = await deterministicServer();
  t.after(async () => {
    await new Promise(resolve => provider.server.close(resolve));
    await rm(agentDir, { recursive: true, force: true });
  });
  for (const [name, content] of [
    ['empty', () => ''],
    [
      'header-only',
      instanceId =>
        `${JSON.stringify({ type: 'session', version: 3, id: instanceId, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
    ],
  ]) {
    const instanceId = `invalid-${name}-${Date.now()}`;
    const sessionFile = join(agentDir, `${instanceId}.jsonl`);
    const originalContent = content(instanceId);
    await writeFile(sessionFile, originalContent);
    const runtime = createSubagentRuntime(
      {
        version: 1,
        piRuntime,
        instanceId,
        parentSessionId: 'parent',
        cwd: process.cwd(),
        agentDir,
        model: { provider: 'subagent-test', id: 'deterministic' },
        thinkingLevel: 'off',
        allowedTools: [],
        resources: { extensionPaths: [providerPath], skillPaths: [], promptTemplatePaths: [], contextFiles: false },
        sessionDir: agentDir,
        sessionFile,
      },
      { env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, PI_OFFLINE: '1' }, startupTimeoutMs: 10_000 },
    );
    try {
      await assert.rejects(runtime.start(), /transcription.*unavailable/i, name);
    } finally {
      await runtime.stop().catch(() => {});
    }
    assert.equal(provider.requests.length, 0);
    assert.equal(
      await readFile(sessionFile, 'utf8'),
      originalContent,
      `${name} transcript was changed during rejection`,
    );
  }
});

test('a restored worker opens its existing private child session for a continuation', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-restored-session-'));
  const provider = await deterministicServer();
  const bootstrap = {
    version: 1,
    piRuntime,
    instanceId: `restored-${Date.now()}`,
    parentSessionId: 'parent',
    cwd: process.cwd(),
    agentDir,
    model: { provider: 'subagent-test', id: 'deterministic' },
    thinkingLevel: 'off',
    allowedTools: [],
    resources: { extensionPaths: [providerPath], skillPaths: [], promptTemplatePaths: [], contextFiles: false },
    sessionDir: agentDir,
  };
  const options = { env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, PI_OFFLINE: '1' }, startupTimeoutMs: 10_000 };
  const firstWorker = createSubagentRuntime(bootstrap, options);
  t.after(async () => {
    await firstWorker.stop().catch(() => {});
    await new Promise(resolve => provider.server.close(resolve));
    await rm(agentDir, { recursive: true, force: true });
  });
  await firstWorker.start();
  const first = await firstWorker.prompt('original mission');
  const firstResult = await first.result;
  await firstWorker.stop();
  const restored = createSubagentRuntime({ ...bootstrap, sessionFile: firstResult.sessionStats.sessionFile }, options);
  t.after(() => restored.stop());
  await restored.start();
  const continued = await restored.prompt('continuation');
  assert.equal((await continued.result).status, 'completed');
  assert.match(JSON.stringify(provider.requests.at(-1).messages), /answer-1-a-b/);
});

test('worker redirects BigInt and circular console values without breaking bootstrap or missions', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-console-values-'));
  const provider = await deterministicServer();
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime,
      instanceId: `console-values-${Date.now()}`,
      parentSessionId: 'parent',
      cwd: process.cwd(),
      agentDir,
      model: { provider: 'subagent-test', id: 'deterministic' },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: {
        extensionPaths: [providerPath, consoleValuesPath],
        skillPaths: [],
        promptTemplatePaths: [],
        contextFiles: false,
      },
    },
    { env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, PI_OFFLINE: '1' }, startupTimeoutMs: 10_000 },
  );
  t.after(async () => {
    await runtime.stop();
    await new Promise(resolve => provider.server.close(resolve));
    await rm(agentDir, { recursive: true, force: true });
  });
  await runtime.start();
  assert.match(runtime.stderr, /123n/);
  assert.match(runtime.stderr, /circular-log/);
  const run = await runtime.prompt('LOG_DURING_RUN');
  assert.equal((await run.result).status, 'completed');
  assert.match(runtime.stderr, /mission-log 456n/);
});

test('real worker rejects steering after agent_end without leaking it into the next run', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-late-steer-'));
  const provider = await deterministicServer();
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime,
      instanceId: `late-steer-${Date.now()}`,
      parentSessionId: 'parent',
      cwd: process.cwd(),
      agentDir,
      model: { provider: 'subagent-test', id: 'deterministic' },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: { extensionPaths: [providerPath], skillPaths: [], promptTemplatePaths: [], contextFiles: false },
    },
    { env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, PI_OFFLINE: '1' }, startupTimeoutMs: 10_000 },
  );
  t.after(async () => {
    await runtime.stop();
    await new Promise(resolve => provider.server.close(resolve));
    await rm(agentDir, { recursive: true, force: true });
  });
  await runtime.start();
  let lateSteer;
  const agentEnded = new Promise(resolve => {
    const unsubscribe = runtime.subscribe(event => {
      if (event.type === 'rpc_event' && event.data?.type === 'agent_end') {
        unsubscribe();
        lateSteer = runtime.steer('MUST_NOT_REACH_NEXT_RUN');
        resolve();
      }
    });
  });
  const first = await runtime.prompt('first run');
  await agentEnded;
  await assert.rejects(lateSteer, /active|finished|streaming/i);
  assert.equal((await first.result).status, 'completed');
  const second = await runtime.prompt('second run');
  assert.equal((await second.result).status, 'completed');
  assert.doesNotMatch(JSON.stringify(provider.requests[1].messages), /MUST_NOT_REACH_NEXT_RUN/);
});

test(
  'real worker crash immediately after spawning children still cleans both groups',
  { skip: process.platform !== 'darwin' },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'subagent-real-crash-'));
    const agentDir = directory;
    const pidFile = join(directory, 'pids.json');
    const provider = await deterministicServer();
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
      await new Promise(resolve => provider.server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    const runtime = createSubagentRuntime(
      {
        version: 1,
        piRuntime,
        instanceId: `real-crash-${Date.now()}`,
        parentSessionId: 'parent',
        cwd: process.cwd(),
        agentDir,
        model: { provider: 'subagent-test', id: 'deterministic' },
        thinkingLevel: 'off',
        allowedTools: [],
        resources: {
          extensionPaths: [providerPath, crashWithChildrenPath],
          skillPaths: [],
          promptTemplatePaths: [],
          contextFiles: false,
        },
      },
      {
        env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, SUBAGENT_TEST_PID_FILE: pidFile, PI_OFFLINE: '1' },
        startupTimeoutMs: 10_000,
      },
    );
    await runtime.start();
    await assert.rejects(runtime.prompt('CRASH_WITH_CHILDREN'), /ended|exited/i);
    const pids = JSON.parse(await readFile(pidFile, 'utf8'));
    const deadline = Date.now() + 3_000;
    while (runtime.status !== 'stopped' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const exists = pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };
    assert.deepEqual(pids.map(exists), [false, false, false]);
    assert.equal(runtime.status, 'stopped');
  },
);

test(
  'real worker crash immediately after detached fork still cleans the forked group',
  { skip: process.platform !== 'darwin' },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'subagent-real-fork-crash-'));
    const pidFile = join(directory, 'pids.json');
    const provider = await deterministicServer();
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
      await new Promise(resolve => provider.server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    const runtime = createSubagentRuntime(
      {
        version: 1,
        piRuntime,
        instanceId: `real-fork-crash-${Date.now()}`,
        parentSessionId: 'parent',
        cwd: process.cwd(),
        agentDir: directory,
        model: { provider: 'subagent-test', id: 'deterministic' },
        thinkingLevel: 'off',
        allowedTools: [],
        resources: {
          extensionPaths: [providerPath, crashWithChildrenPath],
          skillPaths: [],
          promptTemplatePaths: [],
          contextFiles: false,
        },
      },
      {
        env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, SUBAGENT_TEST_PID_FILE: pidFile, PI_OFFLINE: '1' },
        startupTimeoutMs: 10_000,
      },
    );
    await runtime.start();
    await assert.rejects(runtime.prompt('CRASH_WITH_FORK'), /ended|exited/i);
    const pids = JSON.parse(await readFile(pidFile, 'utf8'));
    const deadline = Date.now() + 3_000;
    while (runtime.status !== 'stopped' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const exists = pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };
    assert.deepEqual(pids.map(exists), [false, false]);
    assert.equal(runtime.status, 'stopped');
  },
);

test(
  'runtime cleans a detached group after its recorded leader exits before the worker crashes',
  { skip: process.platform !== 'darwin' },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'subagent-orphaned-group-'));
    const pidFile = join(directory, 'leader.json');
    const orphanPidFile = join(directory, 'orphan.pid');
    const provider = await deterministicServer();
    let leaderPid;
    let orphanPid;
    t.after(async () => {
      if (leaderPid) {
        try {
          process.kill(-leaderPid, 'SIGKILL');
        } catch {}
      }
      if (orphanPid) {
        try {
          process.kill(orphanPid, 'SIGKILL');
        } catch {}
      }
      await new Promise(resolve => provider.server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    const runtime = createSubagentRuntime(
      {
        version: 1,
        piRuntime,
        instanceId: `orphaned-group-${Date.now()}`,
        parentSessionId: 'parent',
        cwd: process.cwd(),
        agentDir: directory,
        model: { provider: 'subagent-test', id: 'deterministic' },
        thinkingLevel: 'off',
        allowedTools: [],
        resources: {
          extensionPaths: [providerPath, crashWithChildrenPath],
          skillPaths: [],
          promptTemplatePaths: [],
          contextFiles: false,
        },
      },
      {
        env: {
          SUBAGENT_TEST_PROVIDER_URL: provider.url,
          SUBAGENT_TEST_PID_FILE: pidFile,
          SUBAGENT_TEST_ORPHAN_PID_FILE: orphanPidFile,
          PI_OFFLINE: '1',
        },
        startupTimeoutMs: 10_000,
      },
    );
    await runtime.start();
    await assert.rejects(runtime.prompt('CRASH_WITH_ORPHANED_GROUP'), /ended|exited/i);
    [, leaderPid] = JSON.parse(await readFile(pidFile, 'utf8'));
    orphanPid = Number(await readFile(orphanPidFile, 'utf8'));
    const deadline = Date.now() + 3_000;
    while (runtime.status !== 'stopped' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const exists = pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };
    assert.equal(exists(orphanPid), false);
    assert.equal(runtime.status, 'stopped');
  },
);

test('worker interception preserves the native promisify contract of exec and execFile', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subagent-promisify-'));
  const resultFile = join(directory, 'result.json');
  const provider = await deterministicServer();
  t.after(async () => {
    await new Promise(resolve => provider.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime,
      instanceId: `promisify-${Date.now()}`,
      parentSessionId: 'parent',
      cwd: process.cwd(),
      agentDir: directory,
      model: { provider: 'subagent-test', id: 'deterministic' },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: {
        extensionPaths: [providerPath, promisifiedChildProcessPath],
        skillPaths: [],
        promptTemplatePaths: [],
        contextFiles: false,
      },
    },
    {
      env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, SUBAGENT_TEST_PROMISIFY_FILE: resultFile, PI_OFFLINE: '1' },
      startupTimeoutMs: 10_000,
    },
  );
  t.after(() => runtime.stop());
  await runtime.start();
  const run = await runtime.prompt('PROMISIFIED_EXEC_FILE');
  assert.equal((await run.result).status, 'no_output');
  assert.deepEqual(JSON.parse(await readFile(resultFile, 'utf8')), {
    fileValue: { stdout: 'ok', stderr: '' },
    execValue: { stdout: 'ok', stderr: '' },
    hasFileChild: true,
    hasExecChild: true,
  });
});

test('stop cleans a detached child created by session_shutdown', { skip: process.platform !== 'darwin' }, async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-shutdown-child-'));
  const provider = await deterministicServer();
  const pidFile = join(agentDir, 'shutdown-child.pid');
  let shutdownPid;
  const runtime = createSubagentRuntime(
    {
      version: 1,
      piRuntime,
      instanceId: `shutdown-child-${Date.now()}`,
      parentSessionId: 'parent',
      cwd: process.cwd(),
      agentDir,
      model: { provider: 'subagent-test', id: 'deterministic' },
      thinkingLevel: 'off',
      allowedTools: [],
      resources: {
        extensionPaths: [providerPath, shutdownChildPath],
        skillPaths: [],
        promptTemplatePaths: [],
        contextFiles: false,
      },
    },
    {
      env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, SUBAGENT_TEST_PID_FILE: pidFile, PI_OFFLINE: '1' },
      startupTimeoutMs: 10_000,
    },
  );
  t.after(async () => {
    if (shutdownPid) {
      try {
        process.kill(-shutdownPid, 'SIGKILL');
      } catch {}
      try {
        process.kill(shutdownPid, 'SIGKILL');
      } catch {}
    }
    await runtime.stop().catch(() => {});
    await new Promise(resolve => provider.server.close(resolve));
    await rm(agentDir, { recursive: true, force: true });
  });
  await runtime.start();
  await runtime.stop();
  shutdownPid = Number(await readFile(pidFile, 'utf8'));
  const exists = pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  assert.equal(runtime.status, 'stopped');
  assert.equal(exists(shutdownPid), false);
});

test(
  'IPC loss during bootstrap cleans children started before runtime creation',
  { skip: process.platform !== 'darwin' },
  async t => {
    const agentDir = await mkdtemp(join(tmpdir(), 'subagent-bootstrap-loss-'));
    const pidFile = join(agentDir, 'child.pid');
    let descendantPid;
    const worker = fork(realWorkerPath, [], {
      silent: true,
      detached: true,
      env: { ...process.env, SUBAGENT_TEST_PID_FILE: pidFile, PI_OFFLINE: '1' },
    });
    t.after(async () => {
      if (descendantPid) {
        try {
          process.kill(-descendantPid, 'SIGKILL');
        } catch {}
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {}
      }
      try {
        process.kill(-worker.pid, 'SIGKILL');
      } catch {}
      await rm(agentDir, { recursive: true, force: true });
    });
    worker.send({
      type: 'subagent-bootstrap',
      bootstrap: {
        version: 1,
        piRuntime,
        instanceId: `bootstrap-loss-${Date.now()}`,
        parentSessionId: 'parent',
        cwd: process.cwd(),
        agentDir,
        model: { provider: 'unused', id: 'unused' },
        thinkingLevel: 'off',
        allowedTools: [],
        resources: {
          extensionPaths: [blockingBootstrapChildPath],
          skillPaths: [],
          promptTemplatePaths: [],
          contextFiles: false,
        },
      },
    });
    const fileDeadline = Date.now() + 5_000;
    while (!descendantPid && Date.now() < fileDeadline) {
      try {
        descendantPid = Number(await readFile(pidFile, 'utf8'));
      } catch {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    assert.ok(descendantPid);
    worker.disconnect();
    const exists = pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };
    const deadline = Date.now() + 3_200;
    while ([worker.pid, descendantPid].some(exists) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual([worker.pid, descendantPid].filter(exists), []);
  },
);

test(
  'parent-loss cleanup includes tracked groups whose leader already exited',
  { skip: process.platform !== 'darwin' },
  async t => {
    const agentDir = await mkdtemp(join(tmpdir(), 'subagent-parent-loss-orphaned-group-'));
    const provider = await deterministicServer();
    const leaderFile = join(agentDir, 'leader.pid');
    const orphanFile = join(agentDir, 'orphan.pid');
    let leaderPid;
    let orphanPid;
    t.after(async () => {
      if (leaderPid) {
        try {
          process.kill(-leaderPid, 'SIGKILL');
        } catch {}
      }
      if (orphanPid) {
        try {
          process.kill(orphanPid, 'SIGKILL');
        } catch {}
      }
      await new Promise(resolve => provider.server.close(resolve));
      await rm(agentDir, { recursive: true, force: true });
    });
    const parent = fork(orphanParentPath, [], { silent: true });
    const workerPid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('orphan launcher timed out')), 10_000);
      parent.once('message', message => {
        clearTimeout(timer);
        resolve(message.workerPid);
      });
      parent.once('error', reject);
      parent.send({
        bootstrap: {
          version: 1,
          piRuntime,
          instanceId: `parent-loss-orphan-${Date.now()}`,
          parentSessionId: 'parent',
          cwd: process.cwd(),
          agentDir,
          model: { provider: 'subagent-test', id: 'deterministic' },
          thinkingLevel: 'off',
          allowedTools: [],
          resources: {
            extensionPaths: [providerPath, orphanedGroupOnStartPath],
            skillPaths: [],
            promptTemplatePaths: [],
            contextFiles: false,
          },
        },
        options: {
          env: {
            SUBAGENT_TEST_PROVIDER_URL: provider.url,
            SUBAGENT_TEST_PID_FILE: leaderFile,
            SUBAGENT_TEST_ORPHAN_PID_FILE: orphanFile,
            PI_OFFLINE: '1',
          },
          startupTimeoutMs: 10_000,
        },
      });
    });
    await new Promise(resolve => parent.once('exit', resolve));
    leaderPid = Number(await readFile(leaderFile, 'utf8'));
    orphanPid = Number(await readFile(orphanFile, 'utf8'));
    const exists = pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };
    const deadline = Date.now() + 3_200;
    while ([workerPid, orphanPid].some(exists) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 25));
    const survivors = [workerPid, orphanPid].filter(exists);
    for (const pid of survivors) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    assert.deepEqual(survivors, []);
  },
);

test('parent-loss escalation survives an immediately exiting worker', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-orphan-fast-exit-'));
  const provider = await deterministicServer();
  const pidFile = join(agentDir, 'children.json');
  let childPids = [];
  t.after(async () => {
    for (const pid of childPids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await new Promise(resolve => provider.server.close(resolve));
    await rm(agentDir, { recursive: true, force: true });
  });
  const parent = fork(orphanParentPath, [], { silent: true });
  const workerPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('orphan launcher timed out')), 10_000);
    parent.once('message', message => {
      clearTimeout(timer);
      resolve(message.workerPid);
    });
    parent.once('error', reject);
    parent.send({
      bootstrap: {
        version: 1,
        piRuntime,
        instanceId: `orphan-fast-${Date.now()}`,
        parentSessionId: 'parent',
        cwd: process.cwd(),
        agentDir,
        model: { provider: 'subagent-test', id: 'deterministic' },
        thinkingLevel: 'off',
        allowedTools: [],
        resources: {
          extensionPaths: [providerPath, childrenOnStartPath],
          skillPaths: [],
          promptTemplatePaths: [],
          contextFiles: false,
        },
      },
      options: {
        env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, SUBAGENT_TEST_PID_FILE: pidFile, PI_OFFLINE: '1' },
        startupTimeoutMs: 10_000,
      },
    });
  });
  await new Promise(resolve => parent.once('exit', resolve));
  childPids = JSON.parse(await readFile(pidFile, 'utf8'));
  const exists = pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  const deadline = Date.now() + 3_200;
  while ([workerPid, ...childPids].some(exists) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 25));
  const survivors = [workerPid, ...childPids].filter(exists);
  for (const pid of survivors) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  assert.deepEqual(survivors, []);
});

test(
  'disconnect watchdog reconciles a child created by session_shutdown',
  { skip: process.platform !== 'darwin' },
  async t => {
    const agentDir = await mkdtemp(join(tmpdir(), 'subagent-disconnect-shutdown-child-'));
    const provider = await deterministicServer();
    const pidFile = join(agentDir, 'shutdown-child.pid');
    const trackFile = join(agentDir, 'tracked.pids');
    await writeFile(trackFile, '');
    let shutdownPid;
    const worker = fork(realWorkerPath, [], {
      silent: true,
      detached: true,
      env: {
        ...process.env,
        SUBAGENT_TEST_PROVIDER_URL: provider.url,
        SUBAGENT_TEST_PID_FILE: pidFile,
        PI_SUBAGENT_TRACK_FILE: trackFile,
        PI_OFFLINE: '1',
      },
    });
    t.after(async () => {
      if (shutdownPid) {
        try {
          process.kill(-shutdownPid, 'SIGKILL');
        } catch {}
        try {
          process.kill(shutdownPid, 'SIGKILL');
        } catch {}
      }
      try {
        process.kill(-worker.pid, 'SIGKILL');
      } catch {}
      await new Promise(resolve => provider.server.close(resolve));
      await rm(agentDir, { recursive: true, force: true });
    });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not become ready')), 10_000);
      worker.on('message', message => {
        if (message?.type === 'subagent-ready') {
          clearTimeout(timer);
          resolve();
        }
      });
      worker.once('error', reject);
    });
    worker.send({
      type: 'subagent-bootstrap',
      bootstrap: {
        version: 1,
        piRuntime,
        instanceId: `disconnect-shutdown-child-${Date.now()}`,
        parentSessionId: 'parent',
        cwd: process.cwd(),
        agentDir,
        model: { provider: 'subagent-test', id: 'deterministic' },
        thinkingLevel: 'off',
        allowedTools: [],
        resources: {
          extensionPaths: [providerPath, shutdownChildPath],
          skillPaths: [],
          promptTemplatePaths: [],
          contextFiles: false,
        },
      },
    });
    await ready;
    worker.disconnect();
    const fileDeadline = Date.now() + 2_000;
    while (!shutdownPid && Date.now() < fileDeadline) {
      try {
        shutdownPid = Number(await readFile(pidFile, 'utf8'));
      } catch {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    assert.ok(shutdownPid);
    const exists = pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };
    const deadline = Date.now() + 3_500;
    while ([worker.pid, shutdownPid].some(exists) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual([worker.pid, shutdownPid].filter(exists), []);
  },
);

test(
  'one-shot watchdog kills a blocked worker when IPC closes but its parent stays alive',
  { skip: process.platform !== 'darwin' },
  async t => {
    const agentDir = await mkdtemp(join(tmpdir(), 'subagent-live-parent-disconnect-'));
    const provider = await deterministicServer();
    const worker = fork(realWorkerPath, [], {
      silent: true,
      detached: true,
      env: { ...process.env, SUBAGENT_TEST_PROVIDER_URL: provider.url, PI_OFFLINE: '1' },
    });
    t.after(async () => {
      try {
        process.kill(-worker.pid, 'SIGKILL');
      } catch {}
      try {
        process.kill(worker.pid, 'SIGKILL');
      } catch {}
      await new Promise(resolve => provider.server.close(resolve));
      await rm(agentDir, { recursive: true, force: true });
    });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not become ready')), 10_000);
      worker.on('message', message => {
        if (message?.type === 'subagent-ready') {
          clearTimeout(timer);
          resolve();
        }
      });
      worker.once('error', reject);
    });
    worker.send({
      type: 'subagent-bootstrap',
      bootstrap: {
        version: 1,
        piRuntime,
        instanceId: `live-parent-${Date.now()}`,
        parentSessionId: 'parent',
        cwd: process.cwd(),
        agentDir,
        model: { provider: 'subagent-test', id: 'deterministic' },
        thinkingLevel: 'off',
        allowedTools: [],
        resources: {
          extensionPaths: [providerPath, blockingSyncShutdownPath],
          skillPaths: [],
          promptTemplatePaths: [],
          contextFiles: false,
        },
      },
    });
    await ready;
    worker.disconnect();
    const exists = () => {
      try {
        process.kill(worker.pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };
    const deadline = Date.now() + 3_200;
    while (exists() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(exists(), false);
  },
);

test('external guardian kills a worker whose shutdown hook blocks the event loop', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-sync-block-'));
  const provider = await deterministicServer();
  const pidFile = join(agentDir, 'children.json');
  let childPids = [];
  t.after(async () => {
    for (const pid of childPids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await new Promise(resolve => provider.server.close(resolve));
    await rm(agentDir, { recursive: true, force: true });
  });
  const parent = fork(orphanParentPath, [], { silent: true });
  const workerPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('orphan launcher timed out')), 10_000);
    parent.once('message', message => {
      clearTimeout(timer);
      resolve(message.workerPid);
    });
    parent.once('error', reject);
    parent.send({
      bootstrap: {
        version: 1,
        piRuntime,
        instanceId: `sync-block-${Date.now()}`,
        parentSessionId: 'parent',
        cwd: process.cwd(),
        agentDir,
        model: { provider: 'subagent-test', id: 'deterministic' },
        thinkingLevel: 'off',
        allowedTools: [],
        resources: {
          extensionPaths: [providerPath, childrenOnStartPath, blockingSyncShutdownPath],
          skillPaths: [],
          promptTemplatePaths: [],
          contextFiles: false,
        },
      },
      options: {
        env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, SUBAGENT_TEST_PID_FILE: pidFile, PI_OFFLINE: '1' },
        startupTimeoutMs: 10_000,
      },
    });
  });
  await new Promise(resolve => parent.once('exit', resolve));
  childPids = JSON.parse(await readFile(pidFile, 'utf8'));
  const exists = pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  const deadline = Date.now() + 3_200;
  while ([workerPid, ...childPids].some(exists) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 25));
  const survivors = [workerPid, ...childPids].filter(exists);
  for (const pid of survivors) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  assert.deepEqual(survivors, []);
});

test('real worker bounds shutdown when parent IPC disappears and a shutdown hook blocks', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'subagent-orphan-'));
  const provider = await deterministicServer();
  const pidFile = join(agentDir, 'children.json');
  let childPids = [];
  t.after(async () => {
    for (const pid of childPids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await new Promise(resolve => provider.server.close(resolve));
    await rm(agentDir, { recursive: true, force: true });
  });
  const parent = fork(orphanParentPath, [], { silent: true });
  const workerPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('orphan launcher timed out')), 10_000);
    parent.once('message', message => {
      clearTimeout(timer);
      resolve(message.workerPid);
    });
    parent.once('error', reject);
    parent.send({
      bootstrap: {
        version: 1,
        piRuntime,
        instanceId: `orphan-${Date.now()}`,
        parentSessionId: 'parent',
        cwd: process.cwd(),
        agentDir,
        model: { provider: 'subagent-test', id: 'deterministic' },
        thinkingLevel: 'off',
        allowedTools: [],
        resources: {
          extensionPaths: [providerPath, childrenOnStartPath, blockingShutdownPath],
          skillPaths: [],
          promptTemplatePaths: [],
          contextFiles: false,
        },
      },
      options: {
        env: { SUBAGENT_TEST_PROVIDER_URL: provider.url, SUBAGENT_TEST_PID_FILE: pidFile, PI_OFFLINE: '1' },
        startupTimeoutMs: 10_000,
      },
    });
  });
  await new Promise(resolve => parent.once('exit', resolve));
  childPids = JSON.parse(await readFile(pidFile, 'utf8'));
  const exists = pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  const deadline = Date.now() + 3_200;
  while ([workerPid, ...childPids].some(exists) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 25));
  const survivors = [workerPid, ...childPids].filter(exists);
  for (const pid of survivors) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  assert.deepEqual(survivors, []);
});

test('a host replaced on disk is rejected before forking', () => {
  assert.throws(
    () =>
      createSubagentRuntime({
        version: 1,
        piRuntime: { ...piRuntime, version: 'not-the-parent' },
        instanceId: 'bad-version',
        parentSessionId: null,
        cwd: process.cwd(),
        agentDir: process.cwd(),
        model: { provider: 'x', id: 'y' },
        thinkingLevel: 'off',
        allowedTools: [],
        resources: { extensionPaths: [], skillPaths: [], promptTemplatePaths: [], contextFiles: false },
      }),
    /restart Pi/i,
  );
});
