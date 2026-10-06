/**
 * Tool result whose model-facing text and renderer details carry the same JSON value.
 * @template T
 * @param {T} value
 * @returns {import('@earendil-works/pi-coding-agent').AgentToolResult<T>}
 */
export function jsonToolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
}
