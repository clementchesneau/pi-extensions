import { parentPort, workerData } from 'node:worker_threads';
import { htmlPage } from './html.js';

// Runs in a worker thread, so that a large or complex page can be stopped and never blocks Pi.
parentPort?.postMessage(htmlPage(workerData.body, workerData.url));
