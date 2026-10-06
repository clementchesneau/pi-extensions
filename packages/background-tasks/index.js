import { TaskManager } from './manager.js';
import { createTaskTools } from './tools.js';
import { createTasksUI } from './ui.js';
import { connectActivityIndicator } from '@clement_chsn/pi-shared/activity-indicator';

export default function backgroundTasks(pi) {
  let active;
  const indicator = connectActivityIndicator(pi);
  const manager = () => {
    if (!active) throw new Error('No active task session');
    return active.manager;
  };
  pi.on('session_start', (_event, ctx) => {
    const session = { ctx };
    session.manager = new TaskManager({
      onFinish: task => {
        if (active !== session) return;
        session.ctx.ui?.notify?.(
          `Task ${task.id}: ${task.state}${task.exitCode === null ? '' : ` (exit ${task.exitCode})`}`,
          task.state === 'completed' ? 'info' : 'warning',
        );
        if (task.resume) {
          pi.sendUserMessage(
            `Background task ${task.id} ended (${task.state}, exit code ${task.exitCode ?? 'none'}). Use task_status and task_output to inspect the result before continuing.`,
            { deliverAs: 'followUp' },
          );
        }
      },
    });
    active = session;
    session.ui = createTasksUI(ctx, session.manager, indicator);
  });
  pi.on('session_tree', () => {
    if (active) {
      // Existing tasks stay visible, but none can resume a different branch.
      for (const task of active.manager.list()) active.manager.disableResume(task.id);
    }
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    const session = active;
    active = undefined;
    if (!session) return;
    session.ui.dispose();
    try {
      const uncertain = await session.manager.close();
      if (uncertain.length)
        ctx.ui?.notify?.(
          `Task cleanup uncertain: ${uncertain.map(task => `${task.id}: ${task.stopError ?? 'unverified'}`).join('; ')}`,
          'error',
        );
    } catch (error) {
      ctx.ui?.notify?.(`Task cleanup uncertain: ${error.message}`, 'error');
    }
  });
  for (const tool of createTaskTools({ getManager: manager })) pi.registerTool(tool);
  pi.registerCommand('ps', {
    description: 'Browse background tasks',
    handler: async (args, ctx) => {
      try {
        if (args.trim()) throw new Error('Usage: /ps');
        if (ctx.mode === 'tui') return await active?.ui.open();
        const tasks = manager().list();
        const data = { tasks: tasks.slice(-20), total: tasks.length, omitted: Math.max(0, tasks.length - 20) };
        ctx.ui?.notify?.(JSON.stringify(data), 'info');
      } catch (error) {
        ctx.ui?.notify?.(error.message, 'error');
      }
    },
  });
}
