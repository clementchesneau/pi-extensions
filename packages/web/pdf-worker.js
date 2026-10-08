import { parentPort, workerData } from 'node:worker_threads';
import { extractText, getDocumentProxy, getMeta } from 'unpdf';

// Runs in a worker thread, so that a large or hostile PDF can be stopped and never blocks Pi.
// verbosity 0 keeps pdf.js warnings off the terminal.
const pdf = await getDocumentProxy(workerData, { verbosity: 0 });
try {
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const { info } = await getMeta(pdf);
  const title = typeof info?.Title === 'string' ? info.Title.trim() : '';
  parentPort?.postMessage({ totalPages, pages: text, title });
} finally {
  await pdf.loadingTask.destroy();
}
