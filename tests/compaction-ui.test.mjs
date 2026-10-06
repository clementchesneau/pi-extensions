import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { formatFooter, stripAnsi } from '../packages/graphite-ui/format.js';

const palette = { muted: '\u001b[90m', accent: '\u001b[36m', warning: '\u001b[33m' };
const style = (token, text) => `${palette[token] ?? '\u001b[37m'}${text}\u001b[39m`;
const data = {
  cwd: '/tmp/project',
  model: 'model',
  contextWindow: 200000,
  cost: 0.128,
  inputTokens: 12000,
  outputTokens: 2000,
  branch: 'main',
  changedFiles: 2,
};

for (const [phase, percent, token] of [
  ['below', 42, 'muted'],
  ['available', 62, 'accent'],
  ['automatic', 95, 'warning'],
  ['compacting', 62, 'accent'],
  ['unknown', null, 'muted'],
  ['available', null, 'muted'],
]) {
  test(`context percentage uses ${token} for ${phase} with ${percent}% without adding text or lines`, () => {
    const baseline = formatFooter({ ...data, width: 100, contextPercent: percent, style });
    const lines = formatFooter({
      ...data,
      width: 100,
      contextPercent: percent,
      style,
      compactionState: { phase, percent, lowPercent: 60, highPercent: 94, enabled: true },
    });
    assert.deepEqual(lines.map(stripAnsi), baseline.map(stripAnsi));
    assert.equal(lines.length, 2);
    const label = percent === null ? '?%' : `${percent}%`;
    assert.ok(lines[1].startsWith(`${palette[token]}${label}\u001b[39m`), lines[1]);
    assert.ok(
      lines[1].includes(`${palette.muted}/200k · $0.128`),
      'capacity, cost and other data retain their neutral color',
    );
    assert.doesNotMatch(stripAnsi(lines.join('\n')), /compaction|L≥|H>|━|─/);
  });
}

test('color-only context preserves the footer layout at every width with and without compaction', () => {
  for (const width of [0, 1, 2, 3, 10, 20, 40, 60, 80, 120]) {
    const baseline = formatFooter({ ...data, width, contextPercent: 62, style });
    const lines = formatFooter({ ...data, width, contextPercent: 62, style, compactionState: { phase: 'available' } });
    assert.deepEqual(lines.map(stripAnsi), baseline.map(stripAnsi));
    assert.equal(lines.length, 2);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
});
