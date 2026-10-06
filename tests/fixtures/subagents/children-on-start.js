import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export default function childrenOnStart(pi) {
  let started = false;
  pi.on('session_start', () => {
    if (started) return;
    started = true;
    const ordinary = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const detached = spawn('/bin/bash', ['-c', 'while :; do sleep 1; done'], { stdio: 'ignore', detached: true });
    if (process.env.SUBAGENT_TEST_PID_FILE) {
      writeFileSync(process.env.SUBAGENT_TEST_PID_FILE, JSON.stringify([ordinary.pid, detached.pid]));
    }
  });
}
