import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TaskManager } from '../packages/background-tasks/manager.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-tasks-test-'));
  const manager = new TaskManager({ directory });
  t.after(async () => {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  });
  return manager;
}

const command = script => `node -e ${JSON.stringify(script)}`;
const startTask = (manager, command, options = {}) => manager.start(command, { title: 'Tâche de test', ...options });

test('tasks require a non-blank title of at most 80 characters and preserve it in snapshots', async t => {
  const manager = await fixture(t);
  for (const title of [undefined, null, 42, '', '   ', 'x'.repeat(81), '🦀'.repeat(81)]) {
    await assert.rejects(manager.start('true', { title }), /title/i);
  }
  assert.equal(manager.list().length, 0, 'invalid titles never launch a task');
  const title = '🦀'.repeat(80);
  const task = await manager.start('true', { title });
  assert.equal(task.title, title);
  assert.equal(manager.get(task.id).title, title);
  assert.equal(manager.list()[0].title, title);
  assert.equal((await manager.wait(task.id, 3000)).task.title, title);
  const trimmed = await manager.start('true', { title: '  Vérifier les tests  ' });
  assert.equal(trimmed.title, 'Vérifier les tests');
});

test('launch returns immediately; wait returns exit code and output for success and failure', async t => {
  const manager = await fixture(t);
  const started = Date.now();
  const task = await startTask(manager, command('setTimeout(() => { console.log("done") }, 350)'));
  assert.equal(task.state, 'running');
  assert.ok(Number.isSafeInteger(task.pid) && task.pid > 0);
  assert.equal(manager.get(task.id).pid, task.pid);
  assert.equal(manager.list()[0].pid, task.pid);
  assert.ok(Date.now() - started < 300);
  const expired = await manager.wait(task.id, 20);
  assert.equal(expired.timedOut, true);
  assert.equal(expired.task.state, 'running');
  const done = await manager.wait(task.id, 3000);
  assert.equal(done.timedOut, false);
  assert.equal(done.task.state, 'completed');
  assert.equal(done.task.pid, task.pid, 'the original shell PID remains available after completion');
  assert.equal(done.task.exitCode, 0);
  assert.match((await manager.output(task.id)).text, /done/);
  const bad = await startTask(manager, command('console.error("bad"); process.exit(7)'));
  assert.equal((await manager.wait(bad.id, 3000)).task.exitCode, 7);
  assert.equal(manager.get(bad.id).state, 'failed');
  assert.match((await manager.output(bad.id)).text, /bad/);
});

test('stdout and stderr can be read separately without changing combined output', async t => {
  const manager = await fixture(t);
  const task = await startTask(manager, command('console.log("OUT-é"); console.error("ERR-🦀")'));
  await manager.wait(task.id, 3000);
  assert.equal((await manager.output(task.id, undefined, 16384, 'stdout')).text, 'OUT-é\n');
  assert.equal((await manager.output(task.id, undefined, 16384, 'stderr')).text, 'ERR-🦀\n');
  const combined = await manager.output(task.id);
  assert.match(combined.text, /OUT-é/);
  assert.match(combined.text, /ERR-🦀/);
  assert.equal(manager.get(task.id).stdoutBytes, Buffer.byteLength('OUT-é\n'));
  assert.equal(manager.get(task.id).stderrBytes, Buffer.byteLength('ERR-🦀\n'));
  await assert.rejects(manager.output(task.id, 0, 10, 'invalid'), /stream/);
});

test('explicit stop and shutdown terminate process groups including descendants', async t => {
  const manager = await fixture(t);
  const spawn = command(
    'require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"ignore"}); setInterval(() => {}, 1000)',
  );
  const task = await startTask(manager, spawn);
  assert.equal((await manager.stop(task.id)).state, 'stopped');
  assert.equal(manager.get(task.id).cleanupUncertain, false);
  const second = await startTask(manager, spawn);
  await manager.close();
  assert.equal(manager.get(second.id).state, 'stopped');
  assert.equal(manager.get(second.id).cleanupUncertain, false);
  assert.deepEqual(await readdir(manager.directory).catch(() => []), []);
});

test('completed tasks release detached descendants before session shutdown', async t => {
  const manager = await fixture(t);
  await startTask(manager, 'true'); // Initializes the private task directory.
  const pidFile = join(manager.directory, 'completed-descendant.pid');
  const script = `const fs = require('node:fs'); const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached:true, stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setTimeout(() => process.exit(0), 300)`;
  const task = await startTask(manager, command(script));
  assert.equal((await manager.wait(task.id, 3000)).task.state, 'completed');
  const pid = Number(await readFile(pidFile, 'utf8'));
  let state = '';
  for (let i = 0; i < 100; i++) {
    try {
      state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
    } catch (error) {
      if (error.status !== 1) throw error;
      state = '';
    }
    if (!state || state.startsWith('Z')) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(!state || state.startsWith('Z'), `completed task left a detached descendant active: ${state}`);
  assert.equal(manager.get(task.id).state, 'completed');
  assert.equal(manager.get(task.id).cleanupUncertain, false);
});

test('stop verifies a child in a separate process group', async t => {
  const manager = await fixture(t);
  await startTask(manager, 'true'); // Initializes the private task directory.
  const pidFile = join(manager.directory, 'descendant.pid');
  const script = `const fs = require('node:fs'); const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached:true, stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000)`;
  const task = await startTask(manager, command(script));
  let pid;
  for (let i = 0; i < 50; i++) {
    try {
      pid = Number(await readFile(pidFile, 'utf8'));
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  assert.ok(pid, 'detached child was started');
  await new Promise(resolve => setTimeout(resolve, 250));
  const stopped = await manager.stop(task.id);
  assert.equal(stopped.cleanupUncertain, false);
  let state = '';
  try {
    state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  assert.ok(!state || state.startsWith('Z'), `descendant remains active: ${state}`);
});

test('stop signals the new group of a descendant observed before it changed group', async t => {
  const manager = await fixture(t);
  await startTask(manager, 'true'); // Initializes the private task directory.
  const pidFile = join(manager.directory, 'mover.pid');
  const goFile = join(manager.directory, 'mover.go');
  // Like a detached child observed between fork and setsid: seen in the task group, then alone.
  const mover = `perl -e '$| = 1; open(my $f, ">", $ARGV[0]); print $f $$; close $f; select(undef, undef, undef, 0.02) until -e $ARGV[1]; setpgrp(0, 0); sleep 30' ${JSON.stringify(pidFile)} ${JSON.stringify(goFile)} </dev/null >/dev/null 2>&1 &`;
  const task = await startTask(manager, `${mover} sleep 30`);
  let pid;
  for (let i = 0; i < 50 && !pid; i++) {
    try {
      pid = Number(await readFile(pidFile, 'utf8'));
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  assert.ok(pid, 'descendant was started');
  t.after(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  });
  const groupOf = () => execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim();
  assert.equal(groupOf(), String(task.pid));
  await new Promise(resolve => setTimeout(resolve, 300)); // Several observation ticks.
  await writeFile(goFile, '');
  for (let i = 0; i < 100 && groupOf() !== String(pid); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(groupOf(), String(pid));
  const stopped = await manager.stop(task.id);
  assert.equal(stopped.cleanupUncertain, false);
  let state = '';
  try {
    state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  assert.ok(!state || state.startsWith('Z'), `descendant remains active: ${state}`);
});

test('simultaneous launches reserve the four slots before asynchronous setup', async t => {
  const manager = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => startTask(manager, 'sleep 5')));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 4);
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every(result => /four concurrent/.test(result.reason.message)));
  assert.equal(manager.list().filter(task => task.state === 'running').length, 4);
});

test('close waits for starts already admitted and stops all their processes', async t => {
  const manager = await fixture(t);
  const starts = Array.from({ length: 4 }, () => startTask(manager, 'sleep 5'));
  const closing = manager.close();
  const launched = await Promise.all(starts);
  const uncertain = await closing;
  assert.deepEqual(uncertain, []);
  assert.equal(manager.list().length, 4);
  assert.ok(launched.every(task => manager.get(task.id).state === 'stopped'));
  assert.deepEqual(await readdir(manager.directory).catch(() => []), []);
  await assert.rejects(startTask(manager, 'true'), /shutting down/);
});

test('stopping a SIGTERM-resistant process does not free a slot before verified exit', async t => {
  const manager = await fixture(t);
  const stubborn = await startTask(
    manager,
    command('process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'),
  );
  for (let i = 0; i < 50; i++) {
    if ((await manager.output(stubborn.id)).text.includes('ready')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match((await manager.output(stubborn.id)).text, /ready/);
  const others = await Promise.all(Array.from({ length: 3 }, () => startTask(manager, 'sleep 5')));
  const stopping = manager.stop(stubborn.id);
  assert.equal(manager.get(stubborn.id).state, 'stopped');
  await assert.rejects(startTask(manager, 'sleep 5'), /four concurrent/);
  await stopping;
  const replacement = await startTask(manager, 'sleep 5');
  assert.equal(replacement.state, 'running');
  for (const task of [...others, replacement]) await manager.stop(task.id);
});

test('output pages do not split UTF-8 characters, even at one byte per request', async t => {
  const manager = await fixture(t);
  const task = await startTask(manager, command('process.stdout.write("éé")'));
  await manager.wait(task.id, 3000);
  let offset = 0;
  let text = '';
  for (let i = 0; i < 8 && offset < 4; i++) {
    const page = await manager.output(task.id, offset, 1);
    assert.ok(page.nextOffset > offset, 'each page makes progress');
    text += page.text;
    offset = page.nextOffset;
  }
  assert.equal(text, 'éé');
  assert.equal(offset, 4);
});

test('output waits for a split UTF-8 character while a task is running', async t => {
  const manager = await fixture(t);
  const task = await startTask(
    manager,
    command(
      'process.stdout.write(Buffer.from([0xc3])); setTimeout(() => { process.stdout.write(Buffer.from([0xa9])) }, 400)',
    ),
  );
  let partial;
  for (let i = 0; i < 50; i++) {
    partial = await manager.output(task.id, 0, 1);
    if (partial.totalBytes === 1) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(partial.totalBytes, 1);
  assert.equal(partial.text, '');
  assert.equal(partial.nextOffset, 0);
  await manager.wait(task.id, 3000);
  assert.equal((await manager.output(task.id, 0, 1)).text, 'é');
});

test('four concurrent tasks, bounded log tail and optional duration limit', async t => {
  const manager = await fixture(t);
  const jobs = await Promise.all(
    Array.from({ length: 4 }, () => startTask(manager, command('setInterval(() => {}, 1000)'))),
  );
  await assert.rejects(startTask(manager, 'true'), /four concurrent/);
  await manager.stop(jobs[0].id);
  const timed = await startTask(manager, command('setInterval(() => {}, 1000)'), { timeoutMs: 80 });
  assert.equal((await manager.wait(timed.id, 3000)).task.state, 'timed_out');
  for (const job of jobs.slice(1)) await manager.stop(job.id);
  const noisy = await startTask(manager, command('process.stdout.write("x".repeat(11 * 1024 * 1024) + "END")'));
  await manager.wait(noisy.id, 5000);
  const output = await manager.output(noisy.id);
  assert.equal(output.truncated, true);
  assert.ok(output.text.length <= 16 * 1024);
  assert.match(output.text, /END/);
});

test('output faster than the log writer waits in the pipe, not in memory', async t => {
  const manager = await fixture(t);
  const baseline = process.memoryUsage().arrayBuffers;
  let peak = 0;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().arrayBuffers - baseline);
  }, 10);
  t.after(() => clearInterval(sampler));
  const flood = await startTask(manager, 'yes | head -c 300000000');
  await new Promise(resolve => setTimeout(resolve, 300));
  const asked = Date.now();
  await manager.output(flood.id);
  const latency = Date.now() - asked;
  // Short waits: a long pending wait timer would keep the test process alive after the test.
  let done;
  for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
    done = await manager.wait(flood.id, 100);
    if (!done.timedOut) break;
  }
  clearInterval(sampler);
  t.diagnostic(`output latency ${latency} ms, peak buffers ${Math.round(peak / 2 ** 20)} MiB`);
  assert.equal(done.task.state, 'completed');
  assert.equal(done.task.totalBytes, 300_000_000);
  assert.ok(latency < 2000, `task_output waited ${latency} ms behind queued output`);
  assert.ok(peak < 192 * 2 ** 20, `${Math.round(peak / 2 ** 20)} MiB of output held in memory`);
});
