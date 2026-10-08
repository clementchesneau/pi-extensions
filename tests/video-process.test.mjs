import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissingProgramError, runProgram } from '../packages/video/process.js';

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a program runs without a shell and returns its exit code and output', async () => {
  const result = await runProgram(process.execPath, [
    '-e',
    "process.stdout.write('out; $(id)'); process.stderr.write('err'); process.exit(3)",
  ]);
  assert.deepEqual(result, { code: 3, stdout: 'out; $(id)', stderr: 'err' });
});

test('a missing program is reported by name', async () => {
  await assert.rejects(runProgram('pi-video-missing-program', []), error => {
    assert.ok(error instanceof MissingProgramError);
    assert.equal(error.program, 'pi-video-missing-program');
    return true;
  });
});

test('cancellation and the time limit stop the program and the processes it started', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-video-process-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = join(directory, 'child.pid');
  const script = `sleep 30 & echo $! > '${pidFile}'; wait`;
  const controller = new AbortController();
  const running = runProgram('/bin/sh', ['-c', script], { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 200));
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  const child = Number(await readFile(pidFile, 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(child), false);

  await assert.rejects(
    runProgram('/bin/sh', ['-c', 'sleep 30'], { timeoutMs: 100 }),
    /sh took longer than 0\.1 seconds/,
  );
});
