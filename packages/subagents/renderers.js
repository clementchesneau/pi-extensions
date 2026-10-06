import { truncateToWidth } from '@earendil-works/pi-tui';
import { duration } from './format.js';
import { singleLineText } from '@clement_chsn/pi-shared/terminal-text';

const eventStateLabel = state =>
  ({ 'confirmation demandée': 'confirmation requested' })[state] ?? singleLineText(state ?? 'unknown state');

function card(text, padding = 0, hidden = () => false) {
  return {
    render(width) {
      return hidden() ? [] : text.split('\n').map(line => truncateToWidth(line, Math.max(0, width - padding * 2)));
    },
    invalidate() {},
  };
}

const RESULT_STATES = new Map([
  ['completed', 'result available (unverified)'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
]);

const resultPreview = (message, details, expanded) =>
  details.state === 'completed' && details.preview
    ? singleLineText(details.preview).slice(0, expanded ? 240 : 120)
    : singleLineText(message.content).slice(0, expanded ? 800 : 120);

/**
 * @typedef {{
 *   state?: string, agentId?: string, runId?: string, alias?: string,
 *   startedAt?: string, finishedAt?: string, preview?: string,
 * }} ResultDetails
 * @typedef {{ alias?: string, state?: string, title?: string }} EventData
 */

/**
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
 * @param {{ wasRead?: (details: ResultDetails) => boolean }} [options]
 */
export function registerSubagentRenderers(pi, { wasRead = () => false } = {}) {
  /** @type {import('@earendil-works/pi-coding-agent').MessageRenderer<ResultDetails>} */
  const renderResult = (message, { expanded, outputPad = 0 }, theme) => {
    const details = message.details ?? {};
    const state = RESULT_STATES.get(details.state) ?? singleLineText(details.state ?? 'unknown state');
    const id = singleLineText(details.agentId ?? '');
    const run = singleLineText(details.runId ?? '');
    const alias = singleLineText(details.alias ?? id);
    const timing = details.startedAt ? ` · ${duration(details)}` : '';
    const finished = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/u.test(details.finishedAt ?? '')
      ? ` · finished ${details.finishedAt.slice(11, 19)} UTC`
      : '';
    const preview = resultPreview(message, details, expanded);
    return card(
      `${theme.fg('accent', `${alias}${timing} · run ${run.slice(0, 12)}${finished}`)}\n${theme.fg(details.state === 'completed' ? 'success' : 'warning', state)}\n${preview}\n/subagents`,
      outputPad,
      () => details.state === 'completed' && wasRead(details),
    );
  };
  /** @type {import('@earendil-works/pi-coding-agent').EntryRenderer<EventData>} */
  const renderEvent = (entry, { expanded = false }, theme) => {
    const data = entry.data ?? {};
    const heading = `${singleLineText(data.alias)} · ${eventStateLabel(data.state)} · ${singleLineText(data.title)}`;
    return card(
      `${theme.fg('accent', heading)}${expanded ? `\n/subagents${data.state === 'cancelled' ? '\nChanges already made remain in place.' : ''}` : ''}`,
    );
  };
  pi.registerMessageRenderer('subagents-result-v1', renderResult);
  pi.registerEntryRenderer('subagents-event-v1', renderEvent);
}
