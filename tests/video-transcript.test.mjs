import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTranscript, parseCaptions } from '../packages/video/transcript.js';

test('WebVTT cues lose their markup, settings and entities', () => {
  const vtt = `WEBVTT
Kind: captions
Language: en

intro
00:00:01.360 --> 00:00:03.040 align:start position:0%
<v Rick>Never &amp; <i>ever</i></v>

01:02:03.500 --> 01:02:05.000
Gonna give&nbsp;you up
`;
  assert.deepEqual(parseCaptions(vtt), [
    { start: 1.36, end: 3.04, text: 'Never & ever' },
    { start: 3723.5, end: 3725, text: 'Gonna give you up' },
  ]);
});

test('SubRip cues from whisper use commas before milliseconds', () => {
  const srt = `1
00:00:00,000 --> 00:00:04,000
 All right, so here we are.

2
00:00:04,000 --> 00:00:14,000
 They have really long trunks.
`;
  assert.deepEqual(parseCaptions(srt), [
    { start: 0, end: 4, text: 'All right, so here we are.' },
    { start: 4, end: 14, text: 'They have really long trunks.' },
  ]);
});

test('rolling automatic captions keep each line once', () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000 align:start position:0%
we're<00:00:00.500><c> no</c><00:00:01.000><c> strangers</c>

00:00:02.000 --> 00:00:02.010 align:start position:0%
we're no strangers
 

00:00:02.010 --> 00:00:04.000 align:start position:0%
we're no strangers
to<00:00:02.500><c> love</c>
`;
  assert.deepEqual(
    parseCaptions(vtt, { rolling: true }).map(cue => cue.text),
    ["we're no strangers", 'to love'],
  );
});

test('a transcript lists timestamped cues within the requested span', () => {
  const cues = [
    { start: 5, end: 9, text: 'before' },
    { start: 58, end: 62, text: 'overlaps the start' },
    { start: 75, end: 80, text: 'inside' },
    { start: 130, end: 135, text: 'after' },
  ];
  assert.equal(formatTranscript(cues), '[0:05] before\n[0:58] overlaps the start\n[1:15] inside\n[2:10] after');
  assert.equal(formatTranscript(cues, { from: 60, to: 120 }), '[0:58] overlaps the start\n[1:15] inside');
});

test('repeated words stay in subtitles and whisper output; only rolling captions lose repeats', () => {
  const apart = '1\n00:00:01,000 --> 00:00:02,000\nNo\n\n2\n00:00:10,000 --> 00:00:11,000\nNo\n';
  assert.deepEqual(
    parseCaptions(apart).map(cue => cue.text),
    ['No', 'No'],
  );
  const contiguous = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nNo\n\n00:00:02.000 --> 00:00:03.000\nNo\n';
  assert.deepEqual(
    parseCaptions(contiguous).map(cue => cue.text),
    ['No', 'No'],
  );
  assert.deepEqual(
    parseCaptions(contiguous, { rolling: true }).map(cue => cue.text),
    ['No'],
  );
  assert.deepEqual(
    parseCaptions(apart, { rolling: true }).map(cue => cue.text),
    ['No', 'No'],
  );
});
