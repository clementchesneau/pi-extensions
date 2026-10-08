// One fake for yt-dlp, ffmpeg, ffprobe and whisper-cli, chosen by the name it was invoked under.
// PI_VIDEO_FAKE names a JSON scenario; every call is appended to the scenario's log file.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const program = basename(process.argv[1]);
const args = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(process.env.PI_VIDEO_FAKE, 'utf8'));
appendFileSync(scenario.log, `${JSON.stringify({ program, args })}\n`);
if (scenario.pidFile && scenario.pidProgram === program) writeFileSync(scenario.pidFile, String(process.pid));
const after = flag => args[args.indexOf(flag) + 1];
const fail = message => {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
};

async function ytDlp() {
  if (scenario.ytdlpError) fail(scenario.ytdlpError);
  if (args.includes('-J')) return process.stdout.write(JSON.stringify(scenario.info));
  if (args.includes('-g')) return process.stdout.write(`${scenario.streamUrl}\n`);
  const template = after('-o');
  if (args.includes('--skip-download')) {
    if (scenario.subtitleError) fail(scenario.subtitleError);
    if (scenario.captions) writeFileSync(template.replace('%(ext)s', `${after('--sub-langs')}.vtt`), scenario.captions);
    return;
  }
  if (scenario.downloadDelayMs) await sleep(scenario.downloadDelayMs);
  const path = template.replace('%(ext)s', 'mp4');
  writeFileSync(path, 'video bytes');
  process.stdout.write(`${path}\n`);
}

function ffmpeg() {
  const output = args.at(-1);
  if (args.includes('null')) {
    for (const cut of scenario.cuts ?? []) process.stderr.write(`[Parsed_showinfo_1] n: 1 pts_time:${cut} duration\n`);
    return;
  }
  if (output.endsWith('.jpg') && scenario.frameError) fail(scenario.frameError);
  if (output.endsWith('.jpg')) return writeFileSync(output, Buffer.from(scenario.jpeg, 'base64'));
  writeFileSync(output, Buffer.alloc(Number(scenario.outputBytes ?? 16)));
}

const programs = {
  'yt-dlp': ytDlp,
  ffmpeg,
  ffprobe: () => process.stdout.write(JSON.stringify(scenario.probe)),
  'whisper-cli': () => {
    if (scenario.whisperError) {
      process.stderr.write(scenario.whisperError);
      process.exit(1);
    }
    writeFileSync(`${after('-of')}.srt`, scenario.whisperSrt ?? '');
  },
};
await programs[program]();
