import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import {
  ACTIVITY_INDICATOR_EVENTS as EVENTS,
  ACTIVITY_INDICATOR_PROTOCOL,
} from '@clement_chsn/pi-shared/activity-indicator';

// A producer replaces its entire contribution with each update. No manager or
// terminal component crosses the extension boundary.
export function formatStatusBar(entries, clock, width, theme, clockActive = true) {
  if (width <= 0) return [];
  const counts = entries.map(({ count, label }) => `${count} ${label}`).join(' · ');
  if (!clock && !counts) return [];
  const color = (name, text) => theme?.fg?.(name, text) ?? text;
  if (!counts) return [truncateToWidth(color(clockActive ? 'accent' : 'dim', clock), width)];
  if (!clock) return [truncateToWidth(color('accent', counts), width)];
  const gap = width - visibleWidth(clock) - visibleWidth(counts);
  return gap >= 2
    ? [`${color(clockActive ? 'accent' : 'dim', clock)}${' '.repeat(gap)}${color('accent', counts)}`]
    : [truncateToWidth(color('accent', counts), width)];
}
export default function activityIndicator(pi) {
  let session;
  const render = () => {
    if (!session) return;
    const entries = [...session.sources.values()];
    if (!entries.length && !session.clock) {
      session.ctx.ui.setWidget?.('activity-indicator', undefined);
      return;
    }
    session.ctx.ui.setWidget?.('activity-indicator', (_tui, theme) => ({
      render: width => formatStatusBar(entries, session.clock, width, theme, session.clockActive),
      invalidate() {},
    }));
  };
  pi.events.on(EVENTS.update, data => {
    if (
      !session ||
      !data ||
      typeof data.source !== 'string' ||
      typeof data.label !== 'string' ||
      !Number.isSafeInteger(data.count) ||
      data.count < 0
    )
      return;
    if (data.count)
      session.sources.set(data.source, {
        label: data.label.replace(/[\x00-\x1f\x7f-\x9f\x1b]/gu, '').slice(0, 40),
        count: data.count,
      });
    else session.sources.delete(data.source);
    render();
  });
  pi.events.on(EVENTS.timer, data => {
    if (!session || typeof data?.text !== 'string') return;
    session.clock = data.text.replace(/[\x00-\x1f\x7f-\x9f\x1b]/gu, '').slice(0, 100);
    session.clockActive = data.active === true;
    render();
  });
  pi.on('session_start', (_event, ctx) => {
    session = ctx.mode === 'tui' ? { ctx, sources: new Map(), clock: '', clockActive: false } : undefined;
    if (session) pi.events.emit(EVENTS.ready, { protocol: ACTIVITY_INDICATOR_PROTOCOL });
  });
  pi.on('session_shutdown', () => {
    session?.ctx.ui.setWidget?.('activity-indicator', undefined);
    session = undefined;
  });
}
