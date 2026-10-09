import { spawn } from 'node:child_process';
import { basename } from 'node:path';

const TIME_LIMIT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const INSTALL = {
  'yt-dlp': 'brew install yt-dlp (macOS) or see https://github.com/yt-dlp/yt-dlp#installation',
  ffmpeg: 'brew install ffmpeg (macOS) or your package manager',
  ffprobe: 'brew install ffmpeg (macOS) or your package manager',
  'whisper-cli': 'brew install whisper.cpp (macOS) or see https://github.com/ggml-org/whisper.cpp',
};

/** A program that is not installed, with the command to install it wherever the error is reported. */
export class MissingProgramError extends Error {
  /** @param {string} program */
  constructor(program) {
    super(`${program} is not installed or not on PATH. Install it with ${INSTALL[program] ?? 'your package manager'}.`);
    this.program = program;
  }
}

function stopGroup(child) {
  try {
    // Detached: the child leads its own process group, which takes its descendants down with it.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* Already gone. */
  }
}

/**
 * Runs a program without a shell and collects its output. Cancellation, the time limit and
 * excessive output kill the program's whole process group.
 * @param {string} program
 * @param {string[]} args
 * @param {{ signal?: AbortSignal, timeoutMs?: number, cwd?: string }} [options]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
export function runProgram(program, args, { signal, timeoutMs = TIME_LIMIT_MS, cwd } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(program, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: [], stderr: [], bytes: 0 };
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      settle(value);
    };
    const fail = error => {
      stopGroup(child);
      finish(reject, error);
    };
    const abort = () => fail(signal?.reason);
    const timer = setTimeout(
      () => fail(new Error(`${basename(program)} took longer than ${timeoutMs / 1000} seconds.`)),
      timeoutMs,
    );
    signal?.addEventListener('abort', abort, { once: true });
    for (const stream of /** @type {const} */ (['stdout', 'stderr'])) {
      child[stream].on('data', chunk => {
        output.bytes += chunk.length;
        if (output.bytes > MAX_OUTPUT_BYTES) fail(new Error(`${basename(program)} produced too much output.`));
        else output[stream].push(chunk);
      });
    }
    child.on('error', error => {
      const missing = /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT';
      finish(reject, missing ? new MissingProgramError(program) : error);
    });
    child.on('close', code =>
      finish(resolve, {
        code,
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8'),
      }),
    );
  });
}
