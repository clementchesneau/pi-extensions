import assert from 'node:assert/strict';
import test from 'node:test';
import * as sdk from '@earendil-works/pi-coding-agent';
import { setCapabilityOverrides } from '@earendil-works/pi-tui';
import { ActivityTranscript, TranscriptReader } from '../packages/subagents/transcript.js';
sdk.initTheme('dark');
const assistant = (text, timestamp) => ({ role: 'assistant', timestamp, content: [{ type: 'text', text }] });
const occurrences = (text, needle) => text.split(needle).length - 1;

test('JSONL keeps the beginning of a large record across many byte pages', () => {
  const message = assistant('BEGIN\n' + 'x'.repeat(80000) + '\nEND', 1);
  const json = JSON.stringify({ message }) + '\n';
  const reader = new TranscriptReader();
  const parsed = [];
  for (let cursor = 0; cursor < json.length; cursor += 4096)
    parsed.push(...reader.push(json.slice(cursor, cursor + 4096)));
  assert.deepEqual(parsed, [message]);
  assert.equal(reader.pending, '');
});

test('snapshot and archive deduplicate assistant timestamps and exact fallback occurrences, not prefixes', () => {
  const transcript = new ActivityTranscript();
  const snapshot = [
    assistant('TIMESTAMP_MESSAGE', 1),
    assistant('REPEATED'),
    assistant('REPEATED'),
    assistant('SAME_PREFIX but distinct'),
  ];
  transcript.snapshot({ runId: 'r1', messages: snapshot, tools: [] });
  transcript.appendArchive([assistant('TIMESTAMP_MESSAGE', 1), assistant('REPEATED'), assistant('SAME_PREFIX')]);
  const text = transcript.render(100).join('\n');
  assert.equal(occurrences(text, 'TIMESTAMP_MESSAGE'), 1);
  assert.equal(occurrences(text, 'REPEATED'), 2, 'legitimate repeated messages must survive');
  assert.equal(occurrences(text, 'SAME_PREFIX'), 2, 'a preview prefix is not an identity');
});

test('equal user instructions at different timestamps survive archive/live reconciliation without catch-up duplicates', () => {
  for (const source of ['live', 'snapshot'])
    for (const archiveFirst of [true, false]) {
      const transcript = new ActivityTranscript();
      const messages = [1, 2].map(timestamp => ({ role: 'user', timestamp, content: 'REPEATED_INSTRUCTION' }));
      if (archiveFirst) transcript.appendArchive([messages[0]]);
      const activeMessages = archiveFirst ? [messages[1]] : messages;
      if (source === 'snapshot') transcript.snapshot({ runId: 'r1', messages: activeMessages, tools: [] });
      else for (const message of activeMessages) transcript.event({ type: 'message_end', message });
      assert.equal(
        occurrences(transcript.render(100).join('\n'), 'REPEATED_INSTRUCTION'),
        2,
        `${source} archiveFirst=${archiveFirst}: different timestamps identify distinct instructions`,
      );
      transcript.appendArchive(archiveFirst ? [messages[1]] : messages);
      assert.equal(
        occurrences(transcript.render(100).join('\n'), 'REPEATED_INSTRUCTION'),
        2,
        'archive catch-up must replace each live copy, not duplicate it',
      );
      assert.equal(transcript.finalized.length, 0);
      if (source === 'snapshot') {
        transcript.snapshot({ runId: 'r1', messages: activeMessages, tools: [] });
        assert.equal(
          occurrences(transcript.render(100).join('\n'), 'REPEATED_INSTRUCTION'),
          2,
          'a refreshed snapshot must reconcile the same archived messages again',
        );
      }
    }
});

test('archive and finalized display windows evict whole records by bytes, without resurrecting reconciled entries', () => {
  const transcript = new ActivityTranscript({ maxBytes: 1024 });
  for (let index = 0; index < 6; index++) {
    const message = assistant(`ENTRY-${index} ${'x'.repeat(700)}`, index);
    transcript.event({ type: 'message_end', message });
    transcript.appendArchive([message]);
  }
  assert.equal(transcript.finalized.length, 0, 'reconciled live entries must not return after archive eviction');
  assert.equal(transcript.archive.length, 1);
  assert.equal(transcript.discarded, true);
  assert.match(transcript.render(100).join('\n'), /ENTRY-5/);
  assert.doesNotMatch(transcript.render(100).join('\n'), /ENTRY-0/);
});

test('parallel active output stays bounded and a finalized result retires its transient copy', () => {
  const transcript = new ActivityTranscript({ maxBytes: 1024 });
  for (let index = 0; index < 10; index++) {
    transcript.event({
      type: 'tool_execution_start',
      toolCallId: `call-${index}`,
      toolName: 'custom',
      args: { index },
    });
    transcript.event({
      type: 'tool_execution_update',
      toolCallId: `call-${index}`,
      partialResult: { content: [{ type: 'text', text: 'x'.repeat(700) }] },
    });
  }
  assert.ok(transcript.tools.size <= 2);
  assert.ok(transcript.tools.has('call-9'));
  assert.equal(transcript.discarded, true);
  transcript.event({
    type: 'tool_execution_end',
    toolCallId: 'call-9',
    result: { content: [{ type: 'text', text: 'done' }] },
  });
  transcript.event({
    type: 'message_end',
    message: {
      role: 'toolResult',
      toolCallId: 'call-9',
      toolName: 'custom',
      content: [{ type: 'text', text: 'done' }],
    },
  });
  assert.equal(transcript.tools.has('call-9'), false);
  assert.equal(occurrences(transcript.render(100).join('\n'), 'done'), 1);
});

test('activity strips main-transcript navigation markers while retaining native colors and links', t => {
  // Native components emit file links only for a terminal detected as supporting OSC 8.
  setCapabilityOverrides({ hyperlinks: true });
  t.after(() => setCapabilityOverrides({}));
  const transcript = new ActivityTranscript();
  transcript.appendArchive([{ role: 'user', content: 'Mission' }, assistant('## Native answer', 1)]);
  transcript.event({
    type: 'tool_execution_start',
    toolCallId: 'read',
    toolName: 'read',
    args: { path: 'fixture.txt' },
  });
  const nativeRows = transcript.components().flatMap(component => component.render(80));
  assert.match(nativeRows.join('\n'), /\x1b\]133;/, 'native components still own the main-transcript markers');
  const rows = transcript.render(80).join('\n');
  assert.doesNotMatch(rows, /\x1b\]133;/, 'an overlay must not redefine terminal prompt/command zones');
  assert.match(rows, /\x1b\[[0-9;]+m/, 'retain native styling');
  assert.match(rows, /\x1b\]8;;file:/, 'retain native file links');
  assert.match(rows, /Native answer/);
});

test('assistant errors and aborts sanitize terminal controls before native rendering on every input path', () => {
  for (const stopReason of ['error', 'aborted'])
    for (const source of ['archive', 'snapshot', 'live']) {
      const transcript = new ActivityTranscript();
      const message = {
        ...assistant('Partial answer', 1),
        stopReason,
        errorMessage: 'FAILURE\x1b[2J\x1b]8;;https://untrusted.invalid\x07DETAIL\x1b]8;;\x07\nNEXT_LINE',
      };
      const original = structuredClone(message);
      if (source === 'archive') transcript.appendArchive([message]);
      else if (source === 'snapshot') transcript.snapshot({ runId: 'r1', messages: [message], tools: [] });
      else transcript.event({ type: 'message_update', message });
      const text = transcript.render(100).join('\n');
      assert.doesNotMatch(
        text,
        /\x1b\[2J|https:\/\/untrusted\.invalid/,
        `${source} ${stopReason} must not inject terminal controls`,
      );
      assert.match(text, /FAILUREDETAIL/);
      assert.match(text, /NEXT_LINE/);
      assert.match(text, /\x1b\[[0-9;]+m/, 'native styling must remain');
      assert.doesNotMatch(text, /\x1b\]133;/);
      assert.deepEqual(message, original, 'sanitization must not mutate the source message');
    }
});

test('user text, assistant text and tool names, argument keys/values and results remain sanitized', () => {
  const transcript = new ActivityTranscript({ expanded: true });
  const inject = text => `${text}\x1b[2J\x1b]133;A\x07`;
  transcript.appendArchive([
    { role: 'user', content: inject('USER_TEXT') },
    assistant(inject('ASSISTANT_TEXT'), 1),
    {
      role: 'toolResult',
      toolCallId: 'archived',
      toolName: inject('archived_custom'),
      content: [{ type: 'text', text: inject('ARCHIVE_RESULT') }],
    },
  ]);
  transcript.event({
    type: 'tool_execution_start',
    toolCallId: 'live',
    toolName: inject('live_custom'),
    args: { [inject('ARG_KEY')]: inject('ARG_VALUE') },
  });
  transcript.event({
    type: 'tool_execution_update',
    toolCallId: 'live',
    partialResult: { content: [{ type: 'text', text: inject('LIVE_RESULT') }] },
  });
  const text = transcript.render(160).join('\n');
  assert.doesNotMatch(text, /\x1b\[2J|\x1b\]133;/);
  for (const value of [
    'USER_TEXT',
    'ASSISTANT_TEXT',
    'archived_custom',
    'ARCHIVE_RESULT',
    'live_custom',
    'ARG_KEY',
    'ARG_VALUE',
    'LIVE_RESULT',
  ])
    assert.ok(text.includes(value), value);
  assert.match(text, /\x1b\[[0-9;]+m/, 'native styling must remain');
});

test('users without timestamps still reconcile exact occurrences, not all equal content', () => {
  const transcript = new ActivityTranscript();
  const message = { role: 'user', content: 'LEGACY_INSTRUCTION' };
  transcript.snapshot({ runId: 'r1', messages: [message, message], tools: [] });
  transcript.appendArchive([message]);
  assert.equal(occurrences(transcript.render(100).join('\n'), 'LEGACY_INSTRUCTION'), 2);
  transcript.appendArchive([message]);
  assert.equal(occurrences(transcript.render(100).join('\n'), 'LEGACY_INSTRUCTION'), 2);
  assert.equal(transcript.finalized.length, 0);
});

test('image artifacts remain identifiable without rendering or copying their payload into native cards', () => {
  const transcript = new ActivityTranscript();
  transcript.appendArchive([
    { role: 'user', content: [{ type: 'image', data: 'PRIVATE_IMAGE_PAYLOAD', mimeType: 'image/png' }] },
    {
      role: 'toolResult',
      toolCallId: 'image',
      toolName: 'custom',
      content: [{ type: 'image', data: 'PRIVATE_IMAGE_PAYLOAD', mimeType: 'image/png' }],
    },
  ]);
  const text = transcript.render(100).join('\n');
  assert.match(text, /Image artifact/);
  assert.match(text, /not displayed/);
  assert.doesNotMatch(text, /PRIVATE_IMAGE_PAYLOAD/);
});

test('tool identity spans snapshot, tool calls, parallel partial updates and archived results', () => {
  const transcript = new ActivityTranscript();
  transcript.snapshot({
    runId: 'r1',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'a', name: 'custom', arguments: { path: 'one' } },
          { type: 'toolCall', id: 'b', name: 'custom', arguments: { path: 'two' } },
        ],
      },
    ],
    tools: [
      { toolCallId: 'a', toolName: 'custom', args: { path: 'one' } },
      { toolCallId: 'b', toolName: 'custom', args: { path: 'two' } },
    ],
  });
  transcript.event({
    type: 'tool_execution_update',
    toolCallId: 'a',
    toolName: 'custom',
    partialResult: { content: [{ type: 'text', text: 'PARTIAL\nNEXT_LINE' }] },
  });
  let text = transcript.render(100).join('\n');
  assert.match(text, /PARTIAL/);
  assert.match(text, /NEXT_LINE/);
  assert.equal(occurrences(text, 'one'), 1);
  assert.equal(occurrences(text, 'two'), 1);
  transcript.event({
    type: 'tool_execution_end',
    toolCallId: 'a',
    toolName: 'custom',
    result: { content: [{ type: 'text', text: 'FINAL' }] },
  });
  transcript.appendArchive([
    { role: 'toolResult', toolCallId: 'a', toolName: 'custom', content: [{ type: 'text', text: 'FINAL' }] },
  ]);
  text = transcript.render(100).join('\n');
  assert.equal(occurrences(text, 'FINAL'), 1);
  assert.equal(occurrences(text, 'one'), 1);
  assert.doesNotMatch(text, /PARTIAL/);
});
