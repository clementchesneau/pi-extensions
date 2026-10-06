// Protocol between the activity-indicator bar and the extensions that feed it, over pi.events.
// Extensions load in any order: `ready` means "send your whole state now", so a producer that
// started with its own widget switches to the bar whenever the bar announces itself.

export const ACTIVITY_INDICATOR_PROTOCOL = 1;

export const ACTIVITY_INDICATOR_EVENTS = Object.freeze({
  /** Bar → producers, at each TUI session start: `{ protocol }`. */
  ready: 'activity-indicator:ready',
  /** Producer → bar: `{ source, label, count }` replaces that source's counter; `count: 0` removes it. */
  update: 'activity-indicator:update',
  /** Producer → bar: `{ text, active }`, the run clock; `text: ''` clears it. */
  timer: 'activity-indicator:timer',
});

/**
 * Producer side. `available` turns true once a compatible bar has announced itself and
 * stays true for the process; `onReady` listeners must then republish their full state.
 */
export function connectActivityIndicator(pi) {
  let available = false;
  const listeners = new Set();
  pi.events?.on(ACTIVITY_INDICATOR_EVENTS.ready, data => {
    if (data?.protocol !== ACTIVITY_INDICATOR_PROTOCOL) return;
    available = true;
    for (const listener of [...listeners]) listener();
  });
  return {
    get available() {
      return available;
    },
    /** @param {() => void} listener @returns {() => void} unsubscribe */
    onReady(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** @param {{ source: string, label: string, count: number }} entry */
    update(entry) {
      if (available) pi.events.emit(ACTIVITY_INDICATOR_EVENTS.update, entry);
    },
    /** @param {{ text: string, active: boolean }} clock */
    timer(clock) {
      if (available) pi.events.emit(ACTIVITY_INDICATOR_EVENTS.timer, clock);
    },
  };
}
