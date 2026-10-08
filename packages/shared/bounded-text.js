import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MAX_LINES = 600;
export const MAX_BYTES = 24_000;

/**
 * Text for the model, cut to MAX_LINES lines and MAX_BYTES UTF-8 bytes. When cut, the complete
 * text is written through `save` and the visible text ends with a notice naming that file.
 * @param {string} text
 * @param {{ save: (text: string) => Promise<string>, subject: string }} options
 *   `save` writes the complete text privately and returns its path; `subject` names what the file
 *   holds in the notice, for example "the complete source".
 * @returns {Promise<{ text: string, truncated: boolean, fullOutputPath?: string }>}
 */
export async function boundedText(text, { save, subject }) {
  const lines = text.split('\n');
  const bytes = Buffer.from(lines.slice(0, MAX_LINES).join('\n'));
  if (lines.length <= MAX_LINES && bytes.length <= MAX_BYTES) return { text, truncated: false };
  const fullOutputPath = await save(text);
  // Streaming decoding omits an incomplete UTF-8 sequence at the byte boundary.
  const visible = new TextDecoder().decode(bytes.subarray(0, MAX_BYTES), { stream: true });
  return {
    text: `${visible}\n\n[Output truncated. Read ${subject} from ${fullOutputPath}]`,
    truncated: true,
    fullOutputPath,
  };
}

/**
 * Writes `data` to `name` in a new private temporary directory (0700) as a private file (0600).
 * @param {string} prefix directory name prefix, for example "pi-web-"
 * @param {string} name
 * @param {string | Uint8Array} data
 */
export async function writePrivateTempFile(prefix, name, data) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const path = join(directory, name);
  await writeFile(path, data, { mode: 0o600 });
  return path;
}
