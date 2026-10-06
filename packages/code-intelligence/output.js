import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LINES = 2_000;
const MAX_BYTES = 50_000;
const SYMBOL_KINDS = [
  '',
  'file',
  'module',
  'namespace',
  'package',
  'class',
  'method',
  'property',
  'field',
  'constructor',
  'enum',
  'interface',
  'function',
  'variable',
  'constant',
  'string',
  'number',
  'boolean',
  'array',
  'object',
  'key',
  'null',
  'enum member',
  'struct',
  'event',
  'operator',
  'type parameter',
];
const SEVERITIES = ['', 'error', 'warning', 'information', 'hint'];

function clean(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function displayPath(uriOrPath, cwd) {
  let path = uriOrPath;
  if (typeof path === 'string' && path.startsWith('file:')) {
    try {
      path = fileURLToPath(path);
    } catch {
      return path;
    }
  }
  if (!isAbsolute(path)) return path;
  const local = relative(cwd, path);
  return local && !local.startsWith('..') && !isAbsolute(local) ? local : path;
}

function locationText(location, cwd, fallbackPath) {
  if (!location) return displayPath(fallbackPath, cwd);
  const uri = location.uri ?? location.targetUri ?? fallbackPath;
  const range = location.range ?? location.targetSelectionRange ?? location.targetRange;
  if (!range?.start) return displayPath(uri, cwd);
  return `${displayPath(uri, cwd)}:${range.start.line + 1}:${range.start.character + 1}`;
}

function symbolLines(symbols, cwd, path, depth = 0) {
  const lines = [];
  for (const symbol of symbols ?? []) {
    const location = symbol.location ?? { uri: path, range: symbol.selectionRange ?? symbol.range };
    lines.push(
      `${locationText(location, cwd, path)} ${'  '.repeat(depth)}${SYMBOL_KINDS[symbol.kind] ?? `kind ${symbol.kind}`} ${clean(symbol.name)}`,
    );
    if (symbol.children) lines.push(...symbolLines(symbol.children, cwd, path, depth + 1));
  }
  return lines;
}

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function hoverText(hover) {
  if (!hover) return [];
  const values = asArray(hover.contents).map(content => {
    if (typeof content === 'string') return content;
    if (typeof content?.value === 'string') return content.value;
    return JSON.stringify(content);
  });
  return values.filter(Boolean);
}

function linesFor(action, raw, { cwd, path }) {
  if (action === 'symbols') return symbolLines(raw, cwd, path);
  if (action === 'definition' || action === 'references') {
    return asArray(raw).map(location => locationText(location, cwd, path));
  }
  if (action === 'hover') return hoverText(raw);
  if (action === 'diagnostics') {
    return asArray(raw).map(diagnostic => {
      const at = locationText({ uri: path, range: diagnostic.range }, cwd, path);
      const severity = SEVERITIES[diagnostic.severity] ?? 'diagnostic';
      const source = diagnostic.source
        ? ` [${clean(diagnostic.source)}${diagnostic.code === undefined ? '' : ` ${diagnostic.code}`}]`
        : '';
      return `${at} ${severity}${source} ${clean(diagnostic.message)}`;
    });
  }
  return [JSON.stringify(raw)];
}

function byteHead(text, maxBytes) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true });
}

/** The first `limit` results, cut to MAX_LINES - 4 physical lines. */
function visibleResults(allLines, limit, action) {
  const shown = allLines.slice(0, limit);
  const body = shown.length ? shown.join('\n') : `No ${action} results.`;
  const physicalLines = body.split('\n');
  const lineTruncated = physicalLines.length > MAX_LINES - 4;
  return {
    shown,
    body: lineTruncated ? physicalLines.slice(0, MAX_LINES - 4).join('\n') : body,
    truncated: allLines.length > shown.length || lineTruncated,
  };
}

async function saveFullOutput(fullText) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-code-nav-'));
  const fullOutputPath = join(directory, 'output.txt');
  await writeFile(fullOutputPath, fullText, { encoding: 'utf8', mode: 0o600 });
  return fullOutputPath;
}

/**
 * @typedef {{
 *   action: string, count: number, truncated: boolean,
 *   incomplete?: boolean, incompleteReason?: string, fullOutputPath?: string,
 * }} CodeNavDetails
 */

/** @returns {Promise<import('@earendil-works/pi-coding-agent').AgentToolResult<CodeNavDetails>>} */
export async function formatCodeNavOutput(action, raw, { cwd, path, limit = 50 }) {
  const diagnosticEnvelope =
    action === 'diagnostics' && !Array.isArray(raw) && Array.isArray(raw?.items) ? raw : undefined;
  const allLines = linesFor(action, diagnosticEnvelope?.items ?? raw, { cwd, path });
  const incomplete = diagnosticEnvelope?.incomplete;
  const warning = incomplete
    ? `\n\n[Diagnostics may be incomplete: ${clean(diagnosticEnvelope.reason ?? 'the server provided no proof that analysis finished.')}]`
    : '';
  const fullText = `${allLines.length ? allLines.join('\n') : `No ${action} results.`}${warning}`;
  const visible = visibleResults(allLines, limit, action);
  const truncated = visible.truncated || Buffer.byteLength(`${visible.body}${warning}`) > MAX_BYTES;
  /** @type {CodeNavDetails} */
  const details = {
    action,
    count: allLines.length,
    truncated,
    ...(incomplete ? { incomplete: true, incompleteReason: diagnosticEnvelope.reason } : {}),
  };
  if (!truncated) return { content: [{ type: 'text', text: `${visible.body}${warning}` }], details };

  const fullOutputPath = await saveFullOutput(fullText);
  details.fullOutputPath = fullOutputPath;
  const notice = `\n\n[Output truncated: showing ${visible.shown.length} of ${allLines.length} results. Read the complete output from ${fullOutputPath}]`;
  const bodyBudget = Math.max(0, MAX_BYTES - Buffer.byteLength(warning) - Buffer.byteLength(notice));
  return { content: [{ type: 'text', text: `${byteHead(visible.body, bodyBudget)}${warning}${notice}` }], details };
}
