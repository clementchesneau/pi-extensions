import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTimestamp, overviewTimes, parseTimestamp } from '../packages/video/frames.js';

test('timestamps read as seconds, m:ss or h:mm:ss and print back compactly', () => {
  assert.equal(parseTimestamp('75'), 75);
  assert.equal(parseTimestamp('2.5'), 2.5);
  assert.equal(parseTimestamp('2:14'), 134);
  assert.equal(parseTimestamp('1:02:03'), 3723);
  for (const invalid of ['', 'abc', '1:75', '-3', '1::2']) assert.throws(() => parseTimestamp(invalid), /timestamp/i);
  assert.equal(formatTimestamp(0), '0:00');
  assert.equal(formatTimestamp(134.4), '2:14');
  assert.equal(formatTimestamp(3723), '1:02:03');
});

test('overview frames cover the whole span evenly when there are no scene cuts', () => {
  assert.deepEqual(overviewTimes({ from: 0, to: 80, cuts: [] }), [5, 15, 25, 35, 45, 55, 65, 75]);
});

test('each overview frame snaps to the scene cut nearest its slot, just after the transition', () => {
  const times = overviewTimes({ from: 0, to: 80, cuts: [2, 13, 17, 41, 79.9] });
  assert.deepEqual(times, [2.2, 13.2, 25, 35, 41.2, 55, 65, 79.9]);
});

test('short spans get fewer frames, at least two seconds apart, and ranges keep their offset', () => {
  assert.deepEqual(overviewTimes({ from: 0, to: 5, cuts: [] }), [1.25, 3.75]);
  assert.deepEqual(overviewTimes({ from: 0, to: 1, cuts: [] }), [0.5]);
  assert.deepEqual(
    overviewTimes({ from: 600, to: 640, cuts: [612] }),
    [602.5, 607.5, 612.2, 617.5, 622.5, 627.5, 632.5, 637.5],
  );
});
