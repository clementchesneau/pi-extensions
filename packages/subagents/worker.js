import { format } from 'node:util';
import { loadHostPiRuntime } from './pi-compatibility.js';
import {
  collectTrackedTree,
  installChildTracking,
  launchCleanupWatchdog,
  signalTree,
  startGuardian,
} from './worker-processes.js';
import {
  assertWorkerBootstrap,
  childResourceSetup,
  createReadinessExtension,
  createRuntimeFactory,
  guardSteering,
  openChildSessionManager,
} from './worker-session.js';

const childTrackFile = process.env.PI_SUBAGENT_TRACK_FILE;
delete process.env.PI_SUBAGENT_TRACK_FILE;
installChildTracking(childTrackFile);
const { worker: workerIdentity, guardianPid } = startGuardian(childTrackFile);

const nativeStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);
for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
  console[method] = (...args) => {
    process.stderr.write(`${format(...args)}\n`);
  };
}

let started = false;
let runtime;

function fatal(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  process.stdin.destroy();
  setTimeout(() => process.exit(1), 25).unref?.();
}

async function boot(bootstrap) {
  if (started) throw new Error('Worker accepts exactly one bootstrap message');
  started = true;
  const sdk = await loadHostPiRuntime(bootstrap?.piRuntime);
  const { VERSION, SessionManager, createAgentSessionRuntime, runRpcMode } = sdk;
  assertWorkerBootstrap(bootstrap);
  const readinessExtension = createReadinessExtension(bootstrap, { version: VERSION, fatal });
  const { settingsManager, resourceOptions } = childResourceSetup(bootstrap, readinessExtension, sdk);
  const createRuntime = createRuntimeFactory({ sdk, bootstrap, settingsManager, resourceOptions });
  const sessionManager = openChildSessionManager(SessionManager, bootstrap);
  runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: bootstrap.cwd,
    agentDir: bootstrap.agentDir,
    sessionManager,
  });
  guardSteering(runtime.session);
  process.stdout.write = nativeStdoutWrite;
  await runRpcMode(runtime);
}

// IPC payloads are untyped; only the bootstrap message is accepted.
process.once('message', (/** @type {any} */ message) => {
  if (message?.type !== 'subagent-bootstrap') return fatal(new Error('Expected subagent bootstrap IPC message'));
  void boot(message.bootstrap).catch(error => {
    process.send?.({
      type: 'subagent-bootstrap-error',
      instanceId: message.bootstrap?.instanceId,
      message: error instanceof Error ? error.message : String(error),
    });
    fatal(error);
  });
});
process.on('disconnect', () => {
  process.stdin.destroy();
  const targets = collectTrackedTree({ trackFile: childTrackFile, guardianPid });
  launchCleanupWatchdog(targets, { worker: workerIdentity, trackFile: childTrackFile });
  if (!runtime) return process.exit(0);
  // Local timers are only a fallback; the guardian remains able to kill this
  // worker when synchronous extension code blocks its event loop.
  setTimeout(() => signalTree(targets, 'SIGKILL'), 1_000);
  setTimeout(() => {
    signalTree(targets, 'SIGKILL');
    process.exit(1);
  }, 2_000);
  try {
    process.kill(process.pid, 'SIGTERM');
  } catch {
    process.exit(1);
  }
});
