import { basename } from 'node:path';
import { formatHeader } from './format.js';

const THEME_NAME = 'graphite';

/** Graphite theme, terminal title, working indicator and compact header. */
export function installChrome(ctx) {
  const themeResult = ctx.ui.setTheme(THEME_NAME);
  if (!themeResult.success) {
    ctx.ui.notify(`Graphite UI: ${themeResult.error}`, 'warning');
  }

  const project = basename(ctx.cwd) || ctx.cwd;
  ctx.ui.setTitle(`π ${project}`);
  // Rotate a four-dot arc around all four braille rows at a relaxed cadence.
  // Custom frames are rendered verbatim, so apply the native accent color here.
  ctx.ui.setWorkingIndicator({
    frames: ['⠏', '⠛', '⠹', '⢸', '⣰', '⣤', '⣆', '⡇'].map(frame => ctx.ui.theme.fg('accent', frame)),
    intervalMs: 110,
  });

  ctx.ui.setHeader((_tui, theme) => ({
    render(width) {
      return formatHeader({
        width,
        project,
        cwd: ctx.cwd,
        style: (token, text) => theme.fg(token, text),
      });
    },
    invalidate() {},
  }));
}

export function restoreDefaults(ctx, { footer = true } = {}) {
  if (ctx?.mode !== 'tui') return;
  ctx.ui.setHeader(undefined);
  if (footer) ctx.ui.setFooter(undefined);
  ctx.ui.setWorkingIndicator();
}
