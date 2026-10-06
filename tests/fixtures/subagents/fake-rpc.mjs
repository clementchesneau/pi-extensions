import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const childTrackFile = process.env.PI_SUBAGENT_TRACK_FILE;
delete process.env.PI_SUBAGENT_TRACK_FILE;
let bootstrap;
let context = [];
let active = false;
let steer = '';
let buffer = '';
const decoder = new StringDecoder('utf8');

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function spawnDescendants() {
  const ordinary = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const detached = spawn('/bin/bash', ['-c', 'while :; do sleep 1; done'], { stdio: 'ignore', detached: true });
  if (childTrackFile) {
    for (const [child, isDetached] of [
      [ordinary, false],
      [detached, true],
    ]) {
      const identity = execFileSync('ps', ['-p', String(child.pid), '-o', 'pgid=,lstart='], {
        encoding: 'utf8',
      }).trim();
      const match = /^(\d+)\s+(.+)$/u.exec(identity);
      appendFileSync(
        childTrackFile,
        `${JSON.stringify({ pid: child.pid, pgid: Number(match[1]), start: match[2].trim(), detached: isDetached })}\n`,
      );
    }
  }
  if (bootstrap.fakePidFile)
    writeFileSync(bootstrap.fakePidFile, JSON.stringify([process.pid, ordinary.pid, detached.pid]));
}
function respond(command, success = true, data, error) {
  output({
    id: command.id,
    type: 'response',
    command: command.type,
    success,
    ...(data === undefined ? {} : { data }),
    ...(error ? { error } : {}),
  });
}
function onCommand(command) {
  if (bootstrap.fakeCommandFile) appendFileSync(bootstrap.fakeCommandFile, `${command.type}\n`);
  if (command.type === 'get_state') {
    const reply = () =>
      respond(command, true, {
        sessionId: bootstrap.instanceId,
        isStreaming: active,
        pendingMessageCount: 0,
        model: bootstrap.model,
        thinkingLevel: bootstrap.thinkingLevel,
        ...bootstrap.fakeState,
      });
    return bootstrap.fakeStateDelayMs ? setTimeout(reply, bootstrap.fakeStateDelayMs) : reply();
  }
  if (command.type === 'get_session_stats') {
    const data = {
      totalMessages: context.length * 2,
      tokens: { input: context.length * 10, output: context.length * 2, total: context.length * 12 },
      cost: 0,
    };
    if (bootstrap.fakeStatsDelayMs) return setTimeout(() => respond(command, true, data), bootstrap.fakeStatsDelayMs);
    return respond(command, true, data);
  }
  if (command.type === 'clear_queue' || command.type === 'abort') {
    active = false;
    respond(command, true, command.type === 'clear_queue' ? { steering: [], followUp: [] } : undefined);
    return;
  }
  if (command.type === 'steer') {
    steer = command.message;
    respond(command);
    return;
  }
  if (command.type === 'prompt') {
    if (bootstrap.fakeSpawnAndCrashOnPrompt) {
      spawnDescendants();
      process.exit(17);
    }
    if (bootstrap.fakeWrongPromptCommandOnce) {
      bootstrap.fakeWrongPromptCommandOnce = false;
      output({ id: command.id, type: 'response', command: 'steer', success: true });
      return;
    }
    if (bootstrap.fakeIgnorePromptResponse) return;
    if (bootstrap.fakeRejectPromptOnce) {
      bootstrap.fakeRejectPromptOnce = false;
      return respond(command, false, undefined, 'simulated rejection');
    }
    if (active) return respond(command, false, undefined, 'already active');
    active = true;
    context.push(command.message);
    respond(command);
    output({ type: 'agent_start' });
    setTimeout(() => {
      const text = `pid=${process.pid};turn=${context.length};prompt=${command.message};steer=${steer}`;
      output({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: bootstrap.fakeNoText
            ? []
            : [
                { type: 'text', text: text.slice(0, 15) },
                { type: 'text', text: text.slice(15) },
              ],
          stopReason: bootstrap.fakeStopReason || 'stop',
          ...(bootstrap.fakeErrorMessage ? { errorMessage: bootstrap.fakeErrorMessage } : {}),
          usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0 } },
        },
      });
      output({ type: 'agent_end', messages: [] });
      setTimeout(() => {
        active = false;
        output({ type: 'agent_settled' });
      }, bootstrap.fakeSettleDelayMs ?? 10);
    }, bootstrap.fakeMessageDelayMs ?? 10);
  }
}

process.on('message', message => {
  if (bootstrap) return;
  bootstrap = message.bootstrap;
  if (bootstrap.fakeStderrBytes) process.stderr.write('x'.repeat(bootstrap.fakeStderrBytes));
  if (bootstrap.fakeIgnoreSigterm) process.on('SIGTERM', () => {});
  if (bootstrap.fakeDescendants) spawnDescendants();
  if (!bootstrap.fakeNoReady)
    process.send?.({
      type: 'subagent-ready',
      instanceId: bootstrap.instanceId,
      piRuntime: bootstrap.fakeReadyRuntime ?? bootstrap.piRuntime,
    });
  if (bootstrap.fakeCrashAfterMs) setTimeout(() => process.exit(17), bootstrap.fakeCrashAfterMs);
});
process.stdin.on('data', chunk => {
  buffer += decoder.write(chunk);
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line) onCommand(JSON.parse(line));
  }
});
process.stdin.on('end', () => {
  if (!bootstrap?.fakeIgnoreEof) process.exit(0);
});
process.on('disconnect', () => {
  if (!bootstrap?.fakeIgnoreEof) process.exit(0);
});
