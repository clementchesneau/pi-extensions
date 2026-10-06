import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {string} text
 * @param {Record<string, unknown>} details
 * @returns {Promise<import('@earendil-works/pi-coding-agent').AgentToolResult<Record<string, unknown>>>}
 */
export async function boundedOutput(text, details) {
  const lines = text.split('\n');
  const head = lines.slice(0, 600).join('\n');
  const bytes = Buffer.from(head);
  const truncated = lines.length > 600 || bytes.length > 24_000;
  if (!truncated) return { content: [{ type: 'text', text }], details: { ...details, truncated: false } };
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-'));
  const fullOutputPath = join(directory, 'source.txt');
  await writeFile(fullOutputPath, text, { encoding: 'utf8', mode: 0o600 });
  // Streaming decoding omits an incomplete UTF-8 sequence at the byte boundary.
  const visible = new TextDecoder().decode(bytes.subarray(0, 24_000), { stream: true });
  return {
    content: [
      { type: 'text', text: `${visible}\n\n[Output truncated. Read the complete source from ${fullOutputPath}]` },
    ],
    details: { ...details, truncated: true, fullOutputPath },
  };
}
