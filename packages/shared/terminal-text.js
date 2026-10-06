const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[^\x1b])/gu;
const CONTROL_OR_LINE_SEPARATOR = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/gu;

/** Untrusted text for one terminal row: escape sequences removed, controls blanked. */
export function singleLineText(value) {
  return String(value ?? '')
    .replace(ESCAPE_SEQUENCE, '')
    .replace(CONTROL_OR_LINE_SEPARATOR, ' ');
}
