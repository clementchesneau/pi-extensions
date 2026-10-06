import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export default function shutdownChild(pi) {
  pi.on('session_shutdown', () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    if (process.env.SUBAGENT_TEST_PID_FILE) writeFileSync(process.env.SUBAGENT_TEST_PID_FILE, String(child.pid));
  });
}
