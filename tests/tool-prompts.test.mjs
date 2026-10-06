import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebTools } from '../packages/web/index.js';
import { createBrowserTools } from '../packages/ui-check/index.js';
import { createCodeNavTool } from '../packages/code-intelligence/index.js';
import { createSubagentTools } from '../packages/subagents/tools.js';
import backgroundTasks from '../packages/background-tasks/index.js';
import askUser from '../packages/ask-user/index.js';
import sessionCompaction from '../packages/session-compaction/index.js';
import { createFakePi } from './fixtures/fake-pi.mjs';

// Exercise Pi's actual prompt builder, not a local approximation.
const { buildSystemPromptSections } = await import(
  new URL('core/system-prompt.js', import.meta.resolve('@earendil-works/pi-coding-agent'))
);
function registeredTools(extension) {
  const fake = createFakePi();
  extension(fake.pi);
  return [...fake.tools.values()];
}
const tools = [
  createCodeNavTool(),
  ...createWebTools(),
  ...createBrowserTools().tools,
  ...createSubagentTools({ getManager: () => ({}) }),
  ...registeredTools(backgroundTasks),
  ...registeredTools(askUser),
  ...registeredTools(sessionCompaction),
];
function sections(selected = tools) {
  return buildSystemPromptSections({
    cwd: process.cwd(),
    selectedTools: selected.map(tool => tool.name),
    toolSnippets: Object.fromEntries(tools.map(tool => [tool.name, tool.promptSnippet])),
    toolGuidelines: Object.fromEntries(tools.map(tool => [tool.name, tool.promptGuidelines ?? []])),
  });
}

test('usage rules distinguish interactive decisions, background commands and delegated work without duplicate bullets', () => {
  const prompt = sections();
  const ask = tools.find(tool => tool.name === 'ask_user').promptGuidelines ?? [];
  assert.equal(ask.length, 1);
  assert.match(ask[0], /prefer ask_user.*decisions.*proposed answers/i);
  assert.match(ask[0], /independent questions/i);
  assert.match(ask[0], /chat.*open-ended.*unavailable/i);
  const start = tools.find(tool => tool.name === 'task_start').promptGuidelines ?? [];
  assert.equal(start.length, 1);
  assert.match(start[0], /task_start.*bash.*long-running commands or services/i);
  const output = tools.find(tool => tool.name === 'task_output').promptGuidelines ?? [];
  assert.equal(output.length, 1);
  assert.match(output[0], /task_status.*task_output/i);
  assert.match(output[0], /services.*readiness separately/i);
  for (const name of ['task_status', 'task_wait', 'task_stop']) {
    assert.equal(tools.find(tool => tool.name === name).promptGuidelines?.length ?? 0, 0);
  }
  const bullets = tools.flatMap(tool => tool.promptGuidelines ?? []);
  assert.equal(new Set(bullets).size, bullets.length, 'Avoid duplicate rules at their source');
  for (const bullet of bullets) {
    assert.equal(prompt.rules.split('\n').filter(line => line === `- ${bullet}`).length, 1);
  }
});

test('inactive tools contribute neither snippets nor guidelines', () => {
  const inactive = new Set(['ask_user', ...tools.filter(tool => tool.name.startsWith('task_')).map(tool => tool.name)]);
  const prompt = sections(tools.filter(tool => !inactive.has(tool.name)));
  for (const tool of tools.filter(tool => inactive.has(tool.name))) {
    assert.ok(!prompt.tools.includes(`- ${tool.name}:`));
    for (const bullet of tool.promptGuidelines ?? []) assert.ok(!prompt.rules.includes(bullet));
  }
});

test('all model tools have concise snippets and appear once in the assembled tool list', () => {
  const prompt = sections();
  for (const tool of tools) {
    assert.ok(tool.promptSnippet?.trim(), `${tool.name}: missing promptSnippet`);
    assert.doesNotMatch(tool.promptSnippet, /\n/);
    assert.ok(tool.promptSnippet.length <= 180, `${tool.name}: snippet is too long`);
    assert.equal(prompt.tools.split('\n').filter(line => line.startsWith(`- ${tool.name}:`)).length, 1);
  }
});
