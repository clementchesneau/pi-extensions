import { Type } from 'typebox';
import { CodeNavManager } from './manager.js';
import { formatCodeNavOutput } from './output.js';

const object = properties => Type.Object(properties, { additionalProperties: false });
const action = name => Type.String({ enum: [name] });
const path = Type.String({
  minLength: 1,
  description: 'TypeScript or JavaScript file path, relative to the current workspace or absolute.',
});
const line = Type.Integer({ minimum: 1, description: 'One-based line number.' });
const column = Type.Integer({ minimum: 1, description: 'One-based column number.' });
const limit = Type.Optional(
  Type.Integer({ minimum: 1, maximum: 200, description: 'Maximum results to display; default 50.' }),
);

const query = Type.Optional(
  Type.String({
    minLength: 1,
    maxLength: 500,
    description: 'When present, search workspace symbols instead of document symbols.',
  }),
);
const actionVariants = Type.Union([
  object({ action: action('symbols'), path, query, limit }),
  object({ action: action('definition'), path, line, column }),
  object({ action: action('references'), path, line, column, limit }),
  object({ action: action('hover'), path, line, column }),
  object({ action: action('diagnostics'), path, limit }),
]);

// Keep root properties for Pi 0.85.1 providers that only forward object fields,
// while allOf preserves strict action-specific validation locally.
export const codeNavParameters = Type.Object(
  {
    action: Type.String({ enum: ['symbols', 'definition', 'references', 'hover', 'diagnostics'] }),
    path,
    line: Type.Optional(line),
    column: Type.Optional(column),
    query,
    limit,
  },
  { additionalProperties: false, allOf: [actionVariants] },
);

export function createCodeNavTool({ manager = new CodeNavManager(), format = formatCodeNavOutput } = {}) {
  return {
    name: 'code_nav',
    label: 'Code Navigation',
    description:
      'Navigate TypeScript and JavaScript with a lazily started local typescript-language-server. Actions: symbols, definition, references, hover, diagnostics. Public line and column values are one-based. Results default to 50 and are capped at 200; oversized output is truncated and saved privately.',
    promptSnippet:
      'Navigate TypeScript/JavaScript symbols, definitions, references, types and diagnostics using a local LSP server.',
    promptGuidelines: [
      'Use code_nav for semantic TypeScript/JavaScript navigation when textual search is insufficient; pass one-based line and column positions.',
    ],
    parameters: codeNavParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const raw = await manager.navigate(params, ctx.cwd, signal);
      signal?.throwIfAborted();
      return format(params.action, raw, {
        cwd: ctx.cwd,
        path: params.path.startsWith('@') ? params.path.slice(1) : params.path,
        limit: params.limit ?? 50,
      });
    },
  };
}

/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
export default function codeIntelligenceExtension(pi) {
  const manager = new CodeNavManager();
  pi.registerTool(createCodeNavTool({ manager }));
  pi.on('session_shutdown', () => manager.close());
}
