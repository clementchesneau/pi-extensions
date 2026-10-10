import { runExtractionWorker } from './extraction-worker.js';

const SIGNATURE = Buffer.from('%PDF-');
const TIME_LIMIT_MS = 20_000;
const MEMORY_LIMIT_MB = 512;

class ExtractionLimitError extends Error {}

/** @param {Uint8Array | undefined} bytes */
export const hasPdfSignature = bytes => Buffer.from(bytes?.subarray(0, SIGNATURE.length) ?? []).equals(SIGNATURE);

/**
 * Extracts the text in a worker thread that is terminated on cancellation, after the time limit,
 * or when its heap exceeds the memory limit.
 * @param {Uint8Array} bytes
 * @param {{ signal?: AbortSignal, timeoutMs: number }} options
 * @returns {Promise<{ totalPages: number, pages: string[], title: string }>}
 */
function extractInWorker(bytes, { signal, timeoutMs }) {
  signal?.throwIfAborted();
  // A fresh copy owns its ArrayBuffer, which can then be transferred instead of cloned.
  const data = new Uint8Array(bytes);
  return runExtractionWorker(new URL('./pdf-worker.js', import.meta.url), data, {
    signal,
    timeoutMs,
    memoryLimitMb: MEMORY_LIMIT_MB,
    transferList: [data.buffer],
    limitError: () =>
      new ExtractionLimitError(
        `PDF text extraction took longer than ${timeoutMs / 1000} seconds; the document is too large or complex.`,
      ),
  });
}

async function readPdf(bytes, { signal, timeoutMs }) {
  try {
    return await extractInWorker(bytes, { signal, timeoutMs });
  } catch (error) {
    if ((signal?.aborted && error === signal.reason) || error instanceof ExtractionLimitError) throw error;
    if (error?.code === 'ERR_WORKER_OUT_OF_MEMORY') {
      throw new Error(`PDF text extraction exceeded its ${MEMORY_LIMIT_MB} MB memory limit.`, { cause: error });
    }
    throw new Error('Cannot read this PDF: it may be damaged, incomplete or password-protected.', { cause: error });
  }
}

/**
 * Text of a PDF, extracted locally with one marked section per page. No OCR.
 * @param {Uint8Array} bytes
 * @param {string} finalUrl
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 */
export async function pdfPage(bytes, finalUrl, { signal, timeoutMs = TIME_LIMIT_MS } = {}) {
  const document = await readPdf(bytes, { signal, timeoutMs });
  if (document.pages.every(text => !text.trim())) {
    throw new Error(
      'This PDF has no extractable text: it may contain scanned images (OCR is not supported) or fonts whose text cannot be decoded.',
    );
  }
  const sections = document.pages.map((text, index) =>
    `[Page ${index + 1} of ${document.totalPages}]\n${text.trim()}`.trimEnd(),
  );
  return { title: document.title || finalUrl, extraction: 'pdf', markdown: sections.join('\n\n') };
}
