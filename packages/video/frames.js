const MIN_GAP_SECONDS = 2;
// Just after a cut, so the frame shows the new scene rather than the transition.
const AFTER_CUT_SECONDS = 0.2;

const round = seconds => Math.round(seconds * 100) / 100;

/**
 * Seconds from "75", "2.5", "2:14" or "1:02:03".
 * @param {string} text
 */
export function parseTimestamp(text) {
  const parts = String(text).trim().split(':');
  const valid =
    parts.length <= 3 &&
    parts.every(part => /^\d+(?:\.\d+)?$/.test(part)) &&
    parts.slice(1).every(part => Number(part) < 60);
  if (!valid) throw new Error(`Invalid timestamp "${text}": use seconds, m:ss or h:mm:ss.`);
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

/** @param {number} seconds */
export function formatTimestamp(seconds) {
  const whole = Math.floor(seconds);
  const [hours, minutes, rest] = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
  const ss = String(rest).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/**
 * Moments for an overview: the span is split into equal slots, at most one per two seconds, and
 * each slot shows the scene cut nearest its middle, or its middle when it has no cut.
 * @param {{ from: number, to: number, cuts: number[], count?: number }} options
 * @returns {number[]}
 */
export function overviewTimes({ from, to, cuts, count = 8 }) {
  const span = Math.max(0, to - from);
  const slots = Math.max(1, Math.min(count, Math.floor(span / MIN_GAP_SECONDS)));
  const width = span / slots;
  return Array.from({ length: slots }, (_, index) => {
    const start = from + index * width;
    const end = start + width;
    const middle = start + width / 2;
    const cut = cuts
      .filter(time => time >= start && time < end)
      .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0];
    if (cut === undefined) return round(middle);
    return round(Math.max(cut, Math.min(cut + AFTER_CUT_SECONDS, end - 0.1)));
  });
}
