import assert from 'node:assert/strict';
import test from 'node:test';
import * as format from '../packages/subagents/format.js';
const { cumulativeUsage } = format;
const usageBreakdownText = (...args) => format.usageBreakdownText(...args);
const contextUsageText = (...args) => format.contextUsageText(...args);

const usage = (totalTokens, cost) => ({
  input: 100,
  output: 20,
  cacheRead: 50,
  cacheWrite: 10,
  totalTokens,
  cost: { total: cost },
});

test('Informations totals include the currently running mission without counting it twice', () => {
  const runs = [
    { state: 'completed', usage: usage(180, 0.01) },
    { state: 'running', usage: usage(320, 0.02) },
  ];
  const text = cumulativeUsage({ runs, run: runs.at(-1) }, { compact: true });
  assert.match(text, /500 tokens/);
  assert.match(text, /\$0\.03/);
  assert.match(text, /live/);
});

test('usage displays separate input output and cache counters rather than hiding their contribution', () => {
  assert.equal(usageBreakdownText(usage(180, 0.01)), 'Input 100 · Output 20 · Cache read 50 · Cache write 10');
  assert.match(usageBreakdownText(undefined), /unavailable/);
});

test('context is an estimated occupation with a limit, not cumulative billed tokens', () => {
  assert.equal(
    contextUsageText({ tokens: 32000, contextWindow: 100000, percent: 32 }),
    'Context · ~32,000 / 100,000 tokens · 32% (estimated)',
  );
  assert.equal(
    contextUsageText({ tokens: null, contextWindow: 100000, percent: null }),
    'Context · unavailable / 100,000 tokens',
  );
  assert.match(contextUsageText(undefined), /unavailable/);
  assert.doesNotMatch(contextUsageText({ tokens: null, contextWindow: 100000, percent: null }), /0%/);
});
