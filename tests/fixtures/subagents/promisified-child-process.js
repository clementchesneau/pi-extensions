import { exec, execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

export default function promisifiedChildProcess(pi) {
  pi.on('input', async event => {
    if (!event.text.includes('PROMISIFIED_EXEC_FILE')) return { action: 'continue' };
    const fileExecution = promisify(execFile)(process.execPath, ['-e', 'process.stdout.write("ok")']);
    const execExecution = promisify(exec)('printf ok');
    const hasFileChild = Boolean(fileExecution.child?.pid);
    const hasExecChild = Boolean(execExecution.child?.pid);
    const [fileValue, execValue] = await Promise.all([fileExecution, execExecution]);
    if (process.env.SUBAGENT_TEST_PROMISIFY_FILE) {
      writeFileSync(
        process.env.SUBAGENT_TEST_PROMISIFY_FILE,
        JSON.stringify({ fileValue, execValue, hasFileChild, hasExecChild }),
      );
    }
    return { action: 'handled' };
  });
}
