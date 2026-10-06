const PHASE_COLORS = {
  available: 'accent',
  automatic: 'warning',
  compacting: 'accent',
};

/** Color only; backend owns thresholds and phase, footer owns the displayed usage. */
export function contextColor(state, percent) {
  if (!Number.isFinite(percent)) return 'muted';
  return PHASE_COLORS[state?.phase] ?? 'muted';
}
