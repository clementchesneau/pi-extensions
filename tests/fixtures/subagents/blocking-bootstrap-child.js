import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export default async function blockingBootstrapChild() {
  const child = spawn('/bin/bash', ['-c', 'while :; do sleep 1; done'], { stdio: 'ignore', detached: true });
  if (process.env.SUBAGENT_TEST_PID_FILE) writeFileSync(process.env.SUBAGENT_TEST_PID_FILE, String(child.pid));
  await new Promise(() => {
    setInterval(() => {}, 1_000);
  });
}
