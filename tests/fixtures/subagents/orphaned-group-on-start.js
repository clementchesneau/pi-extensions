import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { once } from 'node:events';

export default function orphanedGroupOnStart(pi) {
  let started = false;
  pi.on('session_start', async () => {
    if (started) return;
    started = true;
    const leader = spawn('/bin/bash', ['-c', 'sleep 1000 & echo $! > "$SUBAGENT_TEST_ORPHAN_PID_FILE"'], {
      stdio: 'ignore',
      detached: true,
    });
    if (process.env.SUBAGENT_TEST_PID_FILE) writeFileSync(process.env.SUBAGENT_TEST_PID_FILE, String(leader.pid));
    await once(leader, 'exit');
  });
}
