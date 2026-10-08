import { boundedText, writePrivateTempFile } from '@clement_chsn/pi-shared/bounded-text';

/**
 * @param {string} text
 * @param {Record<string, unknown>} details
 * @returns {Promise<import('@earendil-works/pi-coding-agent').AgentToolResult<Record<string, unknown>>>}
 */
export async function boundedOutput(text, details) {
  const output = await boundedText(text, {
    save: full => writePrivateTempFile('pi-web-', 'source.txt', full),
    subject: 'the complete source',
  });
  const { truncated, fullOutputPath } = output;
  return {
    content: [{ type: 'text', text: output.text }],
    details: { ...details, truncated, ...(truncated ? { fullOutputPath } : {}) },
  };
}
