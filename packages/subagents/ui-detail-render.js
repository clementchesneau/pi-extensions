// Pure rendering of the subagent detail page: rows of each tab and the header/footer chrome.
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { singleLineText } from '@clement_chsn/pi-shared/terminal-text';
import {
  contextUsageText,
  cumulativeDuration,
  cumulativeUsage,
  duration,
  stateLabel,
  usageBreakdownText,
  usageText,
} from './format.js';
import { UNFINISHED_STATES } from './run-state.js';

export const TABS = ['response', 'activity', 'information'];
export const trim = (text, max = 4000) => singleLineText(text).slice(0, max);

/**
 * Wraps sanitized text to the page body width, optionally indented and colored.
 * @param {unknown} text
 * @param {number} width
 * @param {{ theme?: any, color?: string, indent?: number }} [options]
 */
export function wrapRows(text, width, { theme, color, indent = 0 } = {}) {
  return String(text ?? '')
    .split('\n')
    .flatMap(line => wrapTextWithAnsi(singleLineText(line), Math.max(1, width - 2 - indent)))
    .map(row => {
      const padded = `${' '.repeat(indent)}${row}`;
      return color ? theme.fg(color, padded) : padded;
    });
}

// Some models emit an entire numbered answer on one source line. Only promote an
// actual 1, 2, ... sequence outside code spans/fences; leave the archived text intact.
export function readableResponse(text) {
  let fenced = false;
  return text
    .split('\n')
    .map(line => {
      if (/^\s*(`{3,}|~{3,})/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const matches = [...line.matchAll(/\s([1-9]\d?)\.\s+(?=\S)/g)].filter(
        match => (line.slice(0, match.index).match(/`/g)?.length ?? 0) % 2 === 0,
      );
      if (matches.length < 2 || matches[0][1] !== '1' || matches[1][1] !== '2') return line;
      let output = line;
      for (let index = matches.length - 1; index >= 0; index--) {
        const match = matches[index];
        if (Number(match[1]) !== index + 1) continue;
        output = `${output.slice(0, match.index)}${index === 0 ? '\n\n' : '\n'}${output.slice(match.index + 1)}`;
      }
      return output;
    })
    .join('\n');
}

/** Markdown rendering of the final response, re-parsed only when its text changes. */
export function createResponseRenderer() {
  let markdown;
  let markdownText;
  return {
    rows(text, theme, width) {
      if (!markdown) {
        const color = name => value => theme.fg(name, value);
        markdown = new Markdown('', 0, 0, {
          heading: color('accent'),
          link: color('accent'),
          linkUrl: color('muted'),
          code: color('accent'),
          codeBlock: color('toolOutput'),
          codeBlockBorder: color('border'),
          quote: color('muted'),
          quoteBorder: color('border'),
          hr: color('border'),
          listBullet: color('accent'),
          bold: color('accent'),
          italic: color('muted'),
          strikethrough: color('dim'),
          underline: color('accent'),
        });
      }
      if (markdownText !== text) {
        markdownText = text;
        markdown.setText(readableResponse(text.replace(/\r\n?/g, '\n').split('\n').map(singleLineText).join('\n')));
      }
      return markdown.render(Math.max(1, Math.min(100, width - 2)));
    },
    invalidate() {
      markdown?.invalidate();
    },
  };
}

function runRows(agent, run, index, info) {
  const instructions = run.instructions?.length
    ? run.instructions.flatMap((instruction, i) =>
        index === 0 && i === 0 && instruction === agent.task
          ? info('↳ Initial mission above', 'muted')
          : [
              ...info(i === 0 ? 'Initial instruction' : `Additional instruction ${i}`, 'muted'),
              ...info(instruction, undefined, 2),
            ],
      )
    : info('Instructions unavailable (legacy archive)', 'muted');
  return [
    ...info(`── Run ${index + 1} · ${stateLabel(run.state)} · ${duration(run)}`, 'accent'),
    ...info(usageText(run.usage, { compact: true }), 'muted'),
    ...info(usageBreakdownText(run.usage), 'muted'),
    ...info(contextUsageText(run.contextUsage), 'muted'),
    ...instructions,
    ...(run.error ? info(run.error, 'error') : []),
    '',
  ];
}

/** Information tab: totals, the initial mission and context, then every run. */
export function informationRows(agent, theme, width) {
  const info = (text, color, indent = 0) => wrapRows(text, width, { theme, color, indent });
  const active = UNFINISHED_STATES.has(agent.run?.state);
  return [
    ...info('── Global', 'accent'),
    ...info(`Total duration: ${cumulativeDuration(agent)}`),
    ...info(cumulativeUsage(agent, { compact: true })),
    ...info(`${active ? 'Current' : 'Latest'} run · ${usageText(agent.run?.usage, { compact: true })}`, 'muted'),
    ...info(usageBreakdownText(agent.run?.usage), 'muted'),
    ...info(contextUsageText(agent.run?.contextUsage), 'muted'),
    ...(active ? info('Usage updates when the provider reports it.', 'dim') : []),
    '',
    ...info('Initial mission', 'muted'),
    ...info(agent.task, undefined, 2),
    '',
    ...(agent.context ? [...info('Initial context', 'muted'), ...info(agent.context, undefined, 2), ''] : []),
    ...info(
      `Model: ${agent.model?.provider ?? 'unavailable'}/${agent.model?.id ?? 'unavailable'} · reasoning: ${agent.thinkingLevel ?? 'unavailable'}`,
      'muted',
    ),
    ...info(`Tools: ${Array.isArray(agent.tools) ? agent.tools.join(', ') : 'unavailable'}`, 'muted'),
    '',
    ...(agent.runs ?? []).flatMap((run, index) => runRows(agent, run, index, info)),
  ];
}

function fullChrome(agent, { tab, status, theme, width }) {
  const active = UNFINISHED_STATES.has(agent.run?.state);
  const border = theme.fg('border', '─'.repeat(Math.max(0, width)));
  const row = text => truncateToWidth(` ${text}`, width);
  const labels = {
    response: 'r Response',
    activity: 'a Activity',
    information: width < 60 ? 'i Info' : 'i Information',
  };
  const titles = { response: 'Latest run · verify', activity: 'Log · all runs', information: 'Overview and runs' };
  const heading = theme.fg('accent', `${trim(agent.alias)}  ${trim(agent.title)}`);
  const state = stateLabel(agent.run?.state);
  const combined = `${heading}  ·  ${theme.fg('muted', state)}`;
  const tabs = TABS.map(id => theme.fg(id === tab ? 'accent' : 'dim', id === tab ? `[${labels[id]}]` : labels[id]));
  const hint = `↑↓/PgUp/PgDn scroll · Home/End · ←→ views${tab === 'activity' ? ' · Ctrl+O expand tools' : ''}${active ? ' · s stop' : ''} · Esc back`;
  const wrap = text => wrapRows(text, width);
  return {
    header: [
      border,
      ...(visibleWidth(combined) + 1 <= width ? [row(combined)] : [row(heading), row(theme.fg('muted', state))]),
      '',
      ...wrapTextWithAnsi(tabs.join(' · '), Math.max(1, width - 2)).map(row),
      row(theme.fg('muted', titles[tab])),
      '',
    ],
    footer: [
      '',
      ...(status ? wrap(status).map(row) : []),
      ...wrap(hint).map(text => row(theme.fg('dim', text))),
      ...(active ? wrap('Stopping does not undo changes.').map(row) : []),
      border,
    ],
  };
}

function compactChrome(agent, { tab, status, theme, width }) {
  const active = UNFINISHED_STATES.has(agent.run?.state);
  const border = theme.fg('border', '─'.repeat(Math.max(0, width)));
  const row = text => truncateToWidth(` ${text}`, width);
  const label = { response: 'Response', activity: 'Activity', information: 'Information' }[tab];
  return {
    header: [
      border,
      row(`${trim(agent.alias)} · ${stateLabel(agent.run?.state)}`),
      row(theme.fg('accent', `r/a/i · ${label}`)),
    ],
    footer: [...(status ? [row(status)] : []), row(theme.fg('dim', `↑↓ ←→${active ? ' s stop' : ''} esc`)), border],
  };
}

/** Header and footer of the detail page; terminals too short for them get a compact variant. */
export function detailChrome(agent, { tab, status, theme, width, rows }) {
  const full = fullChrome(agent, { tab, status, theme, width });
  return full.header.length + full.footer.length + 3 > rows
    ? compactChrome(agent, { tab, status, theme, width })
    : full;
}
