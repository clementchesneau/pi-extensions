import { Type } from 'typebox';
import { jsonToolResult } from '@clement_chsn/pi-shared/tool-result';

const Id = Type.String({ description: 'Task ID returned by task_start' });

const taskStart = getManager => ({
  name: 'task_start',
  label: 'Start background command',
  promptSnippet: 'Run a shell command in the background and return its task ID.',
  promptGuidelines: [
    'Use task_start instead of bash for long-running commands or services when other work can continue while they run.',
  ],
  description:
    'Start a non-interactive shell command with a required short descriptive title (max 80 characters, free form; shown instead of the command in the task list) and immediately return its task ID. Up to four concurrent tasks. Logs retain the latest 10 MiB per output stream (combined, stdout, stderr) until session shutdown. Optional resume triggers a follow-up agent turn at exit (including failure); false by default. No readiness detection for servers.',
  parameters: Type.Object({
    title: Type.String({
      minLength: 1,
      maxLength: 80,
      description:
        'Short description of the task, free form, at most 80 characters; used in the task list and detail header',
    }),
    command: Type.String({
      description: 'Shell command, run in the current working directory (max 4096 characters)',
    }),
    resume: Type.Optional(
      Type.Boolean({ description: 'Resume agent automatically when process exits (default false)' }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 2_147_483_647,
        description: 'Optional maximum runtime in milliseconds; omitted for services',
      }),
    ),
  }),
  execute: async (_id, params, _signal, _update, ctx) => {
    if (params.command.length > 4096) throw new Error('Command exceeds 4096 characters');
    return jsonToolResult(
      await getManager().start(params.command, {
        title: params.title,
        resume: params.resume,
        timeoutMs: params.timeoutMs,
        cwd: ctx.cwd,
      }),
    );
  },
});

const taskStatus = getManager => ({
  name: 'task_status',
  label: 'Background task status',
  promptSnippet: 'List background tasks or inspect one task’s state.',
  description:
    'List tasks in this Pi session in pages of 20 (offset is an index) or inspect one ID; includes state, exitCode, signal, log truncation and cleanup uncertainty. Commands are previewed at 200 characters.',
  parameters: Type.Object({ id: Type.Optional(Id), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
  execute: async (_id, { id, offset = 0 }) => {
    if (id) return jsonToolResult(getManager().get(id));
    const tasks = getManager().list();
    return jsonToolResult({
      tasks: tasks.slice(offset, offset + 20),
      total: tasks.length,
      nextOffset: offset + 20 < tasks.length ? offset + 20 : null,
    });
  },
});

const taskWait = getManager => ({
  name: 'task_wait',
  label: 'Wait for background task',
  promptSnippet: 'Wait a bounded time for a background command to exit.',
  description:
    'Wait up to timeoutMs (0–300000) for exit. An expired wait NEVER stops the task. Returns timedOut and current task status.',
  parameters: Type.Object({ id: Id, timeoutMs: Type.Integer({ minimum: 0, maximum: 300_000 }) }),
  execute: async (_id, { id, timeoutMs }) => jsonToolResult(await getManager().wait(id, timeoutMs)),
});

const taskOutput = getManager => ({
  name: 'task_output',
  label: 'Read task output',
  promptSnippet: 'Read retained background task logs with pagination.',
  promptGuidelines: [
    'Before relying on a background command’s result, check task_status and task_output; for services, verify readiness separately.',
  ],
  description:
    'Read task output as a bounded UTF-8 byte page. stream selects stdout, stderr or combined (default); offsets belong to the selected stream. Without offset reads the tail; with offset reads forward. Returns nextOffset, unavailableBefore and gap when older data was discarded. Max 16384 bytes per call; a 1–3 byte request may include up to 4 bytes to complete a character. An unfinished character may leave nextOffset unchanged.',
  parameters: Type.Object({
    id: Id,
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384 })),
    stream: Type.Optional(Type.Union([Type.Literal('combined'), Type.Literal('stdout'), Type.Literal('stderr')])),
  }),
  execute: async (_id, { id, offset, maxBytes, stream }) =>
    jsonToolResult(await getManager().output(id, offset, maxBytes, stream)),
});

const taskStop = getManager => ({
  name: 'task_stop',
  label: 'Stop background task',
  promptSnippet: 'Stop one background command and its observed descendants.',
  description:
    'Stop the command and observed descendant process groups; verify exit, escalating from TERM to KILL. Reports cleanupUncertain on failure. Does not remove the task result.',
  parameters: Type.Object({ id: Id }),
  execute: async (_id, { id }) => jsonToolResult(await getManager().stop(id)),
});

/** Tools over the current session's task manager; `getManager` throws when no session is active. */
export function createTaskTools({ getManager }) {
  return [
    taskStart(getManager),
    taskStatus(getManager),
    taskWait(getManager),
    taskOutput(getManager),
    taskStop(getManager),
  ];
}
