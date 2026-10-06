import { Type } from 'typebox';
import { Text } from '@earendil-works/pi-tui';
import { createQuestionnaire, displayText } from './ui.js';

const Option = Type.Object({
  value: Type.String({ minLength: 1, description: 'Stable option identifier' }),
  label: Type.String({ minLength: 1, description: 'User-facing answer' }),
  description: Type.Optional(Type.String({ description: 'Short explanation or tradeoff' })),
});
const Question = Type.Object({
  id: Type.String({ minLength: 1, description: 'Unique question identifier' }),
  prompt: Type.String({ minLength: 1, description: 'Full question shown to the user' }),
  options: Type.Array(Option, {
    minItems: 1,
    description: 'Proposed answers; a free-text alternative is always available',
  }),
  multiple: Type.Optional(Type.Boolean({ description: 'Allow several options plus free text (default false)' })),
});
const Output = Type.Object({
  status: Type.Union([Type.Literal('answered'), Type.Literal('cancelled'), Type.Literal('unavailable')]),
  answers: Type.Array(
    Type.Object({
      id: Type.String(),
      prompt: Type.String(),
      selected: Type.Array(Type.Object({ value: Type.String(), label: Type.String() })),
      custom: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});
const result = (status, answers = [], isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify({ status, answers }) }],
  details: { status, answers },
  structuredContent: { status, answers },
  ...(isError ? { isError: true } : {}),
});

function validateQuestions(questions) {
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  const ids = new Set();
  if (!Array.isArray(questions) || !questions.length)
    throw new Error('Invalid questionnaire: at least one question is required');
  for (const q of questions) {
    if (
      !q ||
      !nonempty(q.id) ||
      ids.has(q.id) ||
      !nonempty(q.prompt) ||
      !Array.isArray(q.options) ||
      !q.options.length
    ) {
      throw new Error('Invalid questionnaire: nonempty, unique question IDs, prompts and options are required');
    }
    ids.add(q.id);
    const values = new Set();
    for (const option of q.options) {
      if (!option || !nonempty(option.value) || values.has(option.value) || !nonempty(option.label)) {
        throw new Error('Invalid questionnaire: option values must be unique and labels nonempty');
      }
      values.add(option.value);
    }
  }
}

export default function askUser(pi) {
  let cancel;
  pi.on('session_shutdown', () => cancel?.());
  pi.registerTool({
    name: 'ask_user',
    label: 'Ask user',
    exposure: 'model-only',
    executionMode: 'sequential',
    promptSnippet: 'Ask interactive questions with suggested answers and a free-text alternative.',
    promptGuidelines: [
      'Prefer ask_user for user decisions with meaningful proposed answers; batch only independent questions. Use chat for open-ended discussion or when the tool is unavailable.',
    ],
    description:
      'Ask the user one or more questions with proposed answers and an always-available free-text alternative. Supports single or multiple selections, back navigation and a final summary before submission. Terminal-interactive Pi only; unavailable in subagents and non-TUI modes. Cancellation discards all partial answers; never infer consent from cancellation or unavailability.',
    parameters: Type.Object({ questions: Type.Array(Question, { minItems: 1 }) }),
    outputSchema: Output,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, { questions }, signal, _update, ctx) {
      if (ctx.mode !== 'tui') return result('unavailable', [], true);
      validateQuestions(questions);
      if (signal?.aborted) return result('cancelled');
      if (cancel) throw new Error('A user questionnaire is already open');
      try {
        const answer = await ctx.ui.custom((tui, theme, _keybindings, done) => {
          const component = createQuestionnaire(tui, theme, done, questions);
          cancel = component.cancel;
          signal?.addEventListener('abort', cancel, { once: true });
          if (signal?.aborted) cancel();
          return component;
        });
        return result(answer.status, answer.answers);
      } finally {
        if (cancel) signal?.removeEventListener('abort', cancel);
        cancel = undefined;
      }
    },
    renderCall(args, theme) {
      const count = Array.isArray(args.questions) ? args.questions.length : 0;
      return new Text(theme.fg('toolTitle', theme.bold('ask_user ')) + theme.fg('muted', `${count} question(s)`), 0, 0);
    },
    renderResult(value, _options, theme, context) {
      const details = value.details;
      if (details?.status === 'unavailable')
        return new Text(theme.fg('warning', 'User interaction unavailable (interactive terminal only)'), 0, 0);
      if (details?.status === 'cancelled')
        return new Text(theme.fg('warning', 'Questionnaire cancelled — no answer sent'), 0, 0);
      // Pi supplies details: {} for thrown errors. Only known statuses receive
      // custom rendering; missing/unknown statuses preserve the actual tool text.
      if (details?.status !== 'answered') {
        const text = (value.content ?? [])
          .filter(block => block.type === 'text')
          .map(block => displayText(block.text))
          .join('\n');
        return new Text(theme.fg(context?.isError || value.isError ? 'error' : 'text', text), 0, 0);
      }
      return new Text(
        details.answers
          .map(
            answer =>
              `${theme.fg('success', '✓')} ${displayText(answer.prompt)}\n  ${[
                ...answer.selected.map(option => displayText(option.label)),
                ...(answer.custom ? [`Other: ${displayText(answer.custom)}`] : []),
              ].join(' · ')}`,
          )
          .join('\n'),
        0,
        0,
      );
    },
  });
}
