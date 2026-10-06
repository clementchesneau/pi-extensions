import { fork, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { once } from 'node:events';

export default function crashWithChildren(pi) {
  pi.on('input', async event => {
    if (event.text.includes('CRASH_WITH_ORPHANED_GROUP')) {
      const leader = spawn('/bin/bash', ['-c', 'sleep 1000 & echo $! > "$SUBAGENT_TEST_ORPHAN_PID_FILE"'], {
        stdio: 'ignore',
        detached: true,
      });
      if (process.env.SUBAGENT_TEST_PID_FILE)
        writeFileSync(process.env.SUBAGENT_TEST_PID_FILE, JSON.stringify([process.pid, leader.pid]));
      await once(leader, 'exit');
      process.exit(29);
    }
    if (event.text.includes('CRASH_WITH_FORK')) {
      const child = fork(new URL('./long-lived-child.mjs', import.meta.url), [], { stdio: 'ignore', detached: true });
      if (process.env.SUBAGENT_TEST_PID_FILE) {
        writeFileSync(process.env.SUBAGENT_TEST_PID_FILE, JSON.stringify([process.pid, child.pid]));
      }
      process.exit(23);
    }
    if (!event.text.includes('CRASH_WITH_CHILDREN')) return { action: 'continue' };
    const ordinary = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const detached = spawn('/bin/bash', ['-c', 'while :; do sleep 1; done'], { stdio: 'ignore', detached: true });
    if (process.env.SUBAGENT_TEST_PID_FILE) {
      writeFileSync(process.env.SUBAGENT_TEST_PID_FILE, JSON.stringify([process.pid, ordinary.pid, detached.pid]));
    }
    process.exit(19);
  });
}
