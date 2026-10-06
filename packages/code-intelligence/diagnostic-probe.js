// Diagnostic probes: deliberate compiler errors inserted into a document, so that the
// diagnostics received with them are known to be current. The probe's own diagnostics are
// then dropped and the others shifted back to the original lines.
import ts from 'typescript';

function scriptKindForPath(path) {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const isDirective = comment => /@ts-(?:no)?check\b|^\s*\/\/\/\s*</m.test(comment);

/** End of the last directive comment (`@ts-check`, `/// <…>`) among the comments from `cursor`, or 0. */
function lastDirectiveEnd(text, cursor) {
  let lastEnd = 0;
  while (cursor < text.length) {
    while (/\s/.test(text[cursor] ?? '')) cursor += 1;
    let end;
    if (text.startsWith('//', cursor)) {
      const newline = text.indexOf('\n', cursor + 2);
      end = newline < 0 ? text.length : newline + 1;
    } else if (text.startsWith('/*', cursor)) {
      const close = text.indexOf('*/', cursor + 2);
      if (close < 0) break;
      end = close + 2;
    } else {
      break;
    }
    if (isDirective(text.slice(cursor, end))) lastEnd = end;
    cursor = end;
  }
  return lastEnd;
}

/** End of the last directive-prologue statement (such as 'use strict'), or 0. */
function prologueEnd(text, path) {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKindForPath(path));
  let end = 0;
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    end = statement.end;
  }
  return end;
}

/** Inserts `marker` on its own line after the shebang, directives and prologue that must stay first. */
export function insertDiagnosticProbe(text, marker, path) {
  let shebangEnd = 0;
  if (text.startsWith('#!')) {
    const newline = text.indexOf('\n');
    if (newline < 0) return { text: `${text}\n${marker}`, line: 1 };
    shebangEnd = newline + 1;
  }
  const directiveEnd = lastDirectiveEnd(text, shebangEnd);
  const insertion = prologueEnd(text, path) || directiveEnd || shebangEnd;
  const before = text.slice(0, insertion);
  const inline = Boolean(before && !before.endsWith('\n'));
  const insertionLine = before.match(/\n/g)?.length ?? 0;
  const insertionColumn = insertion - (before.lastIndexOf('\n') + 1);
  const line = insertionLine + (inline ? 1 : 0);
  return {
    text: `${before}${inline ? '\n' : ''}${marker}\n${text.slice(insertion)}`,
    line,
    mapping: { inline, insertionColumn, line },
  };
}

function sameProbeDiagnostic(diagnostic, expected, line) {
  return (
    diagnostic.code === expected.code &&
    diagnostic.range?.start?.line === line &&
    diagnostic.range?.start?.character === expected.character
  );
}

export function isDiagnosticProbe(diagnostic, probe) {
  return probe.diagnostics.some(expected => sameProbeDiagnostic(diagnostic, expected, probe.line));
}

export function hasDiagnosticProbe(diagnostics, probe) {
  return probe.diagnostics.every(expected =>
    diagnostics.some(diagnostic => sameProbeDiagnostic(diagnostic, expected, probe.line)),
  );
}

export function createDeclarationProbeSpec(generation) {
  const bits = generation.toString(2);
  const declaration = index => `declare declare module "__pi_code_nav_probe_${generation}_${index}" {}`;
  let marker = declaration(0);
  const diagnostics = [{ code: 1030, character: 8 }];
  for (let index = 0; index < bits.length; index += 1) {
    marker += bits[index] === '0' ? ' ' : '  ';
    const start = marker.length;
    marker += declaration(index + 1);
    diagnostics.push({ code: 1030, character: start + 8 });
  }
  marker += ' // pi-code-nav diagnostic probe';
  return { marker, diagnostics };
}

export function createProbeSpec(generation, syntax) {
  const bits = generation.toString(2);
  const token = syntax ? 'const = ;' : 'break;';
  const code = syntax ? 1134 : 1105;
  const offset = syntax ? 6 : 0;
  let marker = token;
  const diagnostics = [{ code, character: offset }];
  for (const bit of bits) {
    marker += bit === '0' ? ' ' : '  ';
    const start = marker.length;
    marker += token;
    diagnostics.push({ code, character: start + offset });
  }
  marker += ' // pi-code-nav diagnostic probe';
  return { marker, diagnostics };
}

export function shiftDiagnosticAfterProbe(diagnostic, uri, mapping) {
  const shiftPosition = position => {
    if (!position || position.line <= mapping.line) return position;
    if (!mapping.inline) return { ...position, line: position.line - 1 };
    return {
      ...position,
      line: position.line - 2,
      character: position.line === mapping.line + 1 ? position.character + mapping.insertionColumn : position.character,
    };
  };
  const shiftRange = range =>
    range
      ? {
          ...range,
          start: shiftPosition(range.start),
          end: shiftPosition(range.end),
        }
      : range;
  return {
    ...diagnostic,
    range: shiftRange(diagnostic.range),
    ...(diagnostic.relatedInformation
      ? {
          relatedInformation: diagnostic.relatedInformation.map(information => ({
            ...information,
            location:
              information.location?.uri === uri
                ? { ...information.location, range: shiftRange(information.location.range) }
                : information.location,
          })),
        }
      : {}),
  };
}
