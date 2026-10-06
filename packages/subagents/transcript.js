import * as publicSdk from '@earendil-works/pi-coding-agent';
import { updateAssistantMessage } from './assistant-stream.js';
import { singleLineText } from '@clement_chsn/pi-shared/terminal-text';

// Sanitize terminal controls without flattening Markdown/code or live newlines.
const cleanText = text =>
  String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(singleLineText)
    .join('\n');
const cleanValue = value =>
  typeof value === 'string'
    ? cleanText(value)
    : Array.isArray(value)
      ? value.map(cleanValue)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [cleanText(key), cleanValue(item)]))
        : value;
const displayContent = content =>
  (content ?? []).map(block =>
    block.type === 'image' ? { type: 'text', text: '[Image artifact (not displayed)]' } : block,
  );
const displayResult = result => (result ? { ...result, content: displayContent(result.content) } : undefined);
const contentText = content =>
  typeof content === 'string'
    ? cleanText(content)
    : displayContent(content)
        .filter(block => block.type === 'text')
        .map(block => cleanText(block.text))
        .join('\n');
const supported = message => message && ['assistant', 'user', 'toolResult'].includes(message.role);
const identity = message =>
  message.role === 'toolResult' && message.toolCallId
    ? `tool:${message.toolCallId}`
    : ['assistant', 'user'].includes(message.role) && message.timestamp !== undefined
      ? JSON.stringify([message.role, message.timestamp, message.content])
      : JSON.stringify([message.role, message.content, message.toolName, message.isError ?? false]);

export function transcriptMessages(text) {
  return String(text)
    .split('\n')
    .flatMap(line => {
      try {
        const { message } = JSON.parse(line);
        return supported(message) ? [message] : [];
      } catch {
        return [];
      }
    });
}

// A JSONL record can span many byte pages. Never trim an unfinished record:
// doing so loses the JSON opening and silently discards the whole message.
export class TranscriptReader {
  pending = '';
  push(text) {
    const combined = this.pending + text;
    const boundary = combined.lastIndexOf('\n');
    if (boundary < 0) {
      this.pending = combined;
      return [];
    }
    this.pending = combined.slice(boundary + 1);
    return transcriptMessages(combined.slice(0, boundary + 1));
  }
}

const factories = {
  read: 'createReadToolDefinition',
  bash: 'createBashToolDefinition',
  edit: 'createEditToolDefinition',
  write: 'createWriteToolDefinition',
  grep: 'createGrepToolDefinition',
  find: 'createFindToolDefinition',
  ls: 'createLsToolDefinition',
};

// Display entries are built into a view: `entries` in order, `calls` indexing tool entries.
function addToolEntry(view, key, tool) {
  view.calls.set(key, tool);
  view.entries.push({ id: `tool:${key}`, kind: 'tool', value: tool });
  return tool;
}

function addAssistant(view, { message, id }, streaming) {
  // Sanitize the whole native input, including error/abort metadata,
  // rather than stripping the rendered output (which owns colors/links).
  const clean = cleanValue({
    ...message,
    content: (message.content ?? []).filter(block => block?.type === 'text' || block?.type === 'toolCall'),
  });
  if (
    clean.content.some(block => block.type === 'text') ||
    clean.stopReason === 'error' ||
    clean.stopReason === 'aborted'
  )
    view.entries.push({ id: `message:${id}`, kind: 'assistant', value: clean, streaming });
  for (const block of message.content ?? []) {
    if (block?.type !== 'toolCall') continue;
    const key = block.id ?? `legacy:${id}:${view.calls.size}`;
    const call = { toolName: block.name, args: block.arguments, argsComplete: !streaming };
    if (view.calls.has(key)) Object.assign(view.calls.get(key), call);
    else addToolEntry(view, key, { toolCallId: key, ...call });
  }
}

function addToolResult(view, { message, id }) {
  const key = message.toolCallId ?? `legacy-result:${id}`;
  const tool =
    view.calls.get(key) ?? addToolEntry(view, key, { toolCallId: key, toolName: message.toolName ?? 'tool', args: {} });
  Object.assign(tool, { result: message, finished: true, isError: message.isError });
}

function addRecord(view, record, streaming = false) {
  const { message, id } = record;
  if (message.role === 'assistant') addAssistant(view, record, streaming);
  else if (message.role === 'user')
    view.entries.push({ id: `message:${id}`, kind: 'user', value: contentText(message.content) });
  else if (message.role === 'toolResult') addToolResult(view, record);
}

function addLiveTools(view, tools) {
  for (const [id, state] of tools) {
    const tool = view.calls.get(id) ?? addToolEntry(view, id, { toolCallId: id });
    // A persisted result is authoritative over an older in-flight snapshot.
    if (tool.finished) {
      tool.args = state.args ?? tool.args;
      tool.argsComplete = true;
    } else Object.assign(tool, state);
  }
}

export class ActivityTranscript {
  /**
   * @param {{
   *   sdk?: typeof publicSdk,
   *   tui?: import('@earendil-works/pi-tui').TUI,
   *   cwd?: string,
   *   maxMessages?: number,
   *   maxBytes?: number,
   *   expanded?: boolean,
   * }} [options]
   */
  constructor({
    sdk = publicSdk,
    tui,
    cwd = process.cwd(),
    maxMessages = 600,
    maxBytes = 2 * 1024 * 1024,
    expanded = false,
  } = {}) {
    this.sdk = sdk;
    // ToolExecutionComponent only calls requestRender() on its TUI.
    this.tui = tui ?? /** @type {import('@earendil-works/pi-tui').TUI} */ ({ requestRender() {} });
    this.cwd = cwd;
    this.maxMessages = maxMessages;
    this.maxBytes = maxBytes;
    this.expanded = expanded;
    this.archive = [];
    this.finalized = [];
    this.tools = new Map();
    this.cache = new Map();
    this.renderers = new Map();
    this.discarded = false;
    this.serial = 0;
    this.message = undefined;
  }
  record(message, runId) {
    return {
      message,
      id: ++this.serial,
      runId,
      key: identity(message),
      bytes: Buffer.byteLength(JSON.stringify(message)),
    };
  }
  trimRecords(records) {
    const removed = [];
    let bytes = records.reduce((sum, record) => sum + record.bytes, 0);
    // Keep at least one complete record, even when that single record exceeds
    // the display window. A JSON prefix or a cut result is never retained.
    while (records.length > this.maxMessages || (records.length > 1 && bytes > this.maxBytes)) {
      const record = records.shift();
      bytes -= record.bytes;
      removed.push(record);
    }
    if (removed.length) this.discarded = true;
    return removed;
  }
  trimTools() {
    const results = new Set(
      [...this.archive, ...this.finalized]
        .filter(record => record.message.role === 'toolResult')
        .map(record => record.message.toolCallId),
    );
    for (const [id, tool] of this.tools) if (tool.finished && results.has(id)) this.tools.delete(id);
    let bytes = [...this.tools.values()].reduce((sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool)), 0);
    while (this.tools.size > 128 || (this.tools.size > 1 && bytes > this.maxBytes)) {
      const [id, tool] = [...this.tools].find(([, value]) => value.finished) ?? this.tools.entries().next().value;
      this.tools.delete(id);
      bytes -= Buffer.byteLength(JSON.stringify(tool));
      this.discarded = true;
    }
  }
  appendArchive(messages) {
    const added = messages.map(message => this.record(message));
    this.archive.push(...added);
    // Retire the transient finalized copy as soon as its durable counterpart
    // arrives, or it would reappear after an older archive page is evicted.
    this.finalized = this.reconcile(this.finalized);
    const removed = this.trimRecords(this.archive);
    this.trimTools();
    return removed;
  }
  snapshot(snapshot) {
    if (!snapshot) return;
    this.runId = snapshot.runId;
    this.finalized = [
      ...this.finalized.filter(record => record.runId !== snapshot.runId),
      ...this.reconcile(
        (snapshot.messages ?? [])
          .filter(supported)
          .map(message => this.record(structuredClone(message), snapshot.runId)),
        true,
      ),
    ];
    this.trimRecords(this.finalized);
    this.discarded ||= snapshot.discarded ?? false;
    this.message = snapshot.message ? structuredClone(snapshot.message) : undefined;
    this.tools = new Map((snapshot.tools ?? []).map(tool => [tool.toolCallId, structuredClone(tool)]));
    this.trimTools();
  }
  reconcile(records, includeMatched = false) {
    const available = new Map();
    for (const record of this.archive) {
      if (record.matchedLive && !includeMatched) continue;
      const queue = available.get(record.key) ?? [];
      queue.push(record);
      available.set(record.key, queue);
    }
    return records.filter(record => {
      const archived = available.get(record.key)?.shift();
      if (!archived) return true;
      archived.matchedLive = true;
      return false;
    });
  }
  records() {
    return [...this.archive, ...this.finalized];
  }
  event(data) {
    if (data?.type === 'message_start' || data?.type === 'message_update') {
      this.message = updateAssistantMessage(this.message, data);
    }
    if (data?.type === 'message_end' && supported(data.message)) {
      this.finalized.push(this.record(structuredClone(data.message), this.runId));
      this.finalized = this.reconcile(this.finalized);
      this.trimRecords(this.finalized);
      if (data.message.role === 'assistant') this.message = undefined;
    }
    const toolEvent = data?.type?.startsWith('tool_execution_');
    if (toolEvent) this.#toolEvent(data);
    if (data?.type === 'message_end' || toolEvent) this.trimTools();
  }
  #toolEvent(data) {
    if (data.type === 'tool_execution_start') this.tools.set(data.toolCallId, { ...data, finished: false });
    if (data.type === 'tool_execution_update' || data.type === 'tool_execution_end') {
      this.tools.set(data.toolCallId, {
        ...this.tools.get(data.toolCallId),
        ...data,
        result: data.result ?? data.partialResult,
        finished: data.type === 'tool_execution_end',
        isPartial: data.type !== 'tool_execution_end',
      });
    }
  }
  setExpanded(expanded) {
    this.expanded = expanded;
    for (const [id, { component }] of this.cache) if (id.startsWith('tool:')) component.setExpanded(expanded);
  }
  toolRenderers(name) {
    if (!this.renderers.has(name)) {
      const definition = this.sdk[factories[name]]?.(this.cwd);
      // Only drawing callbacks cross this boundary: tools are never executed.
      this.renderers.set(
        name,
        definition
          ? {
              renderCall: definition.renderCall,
              renderResult: definition.renderResult,
              renderShell: definition.renderShell,
            }
          : {},
      );
    }
    return this.renderers.get(name);
  }
  components() {
    const view = { entries: [], calls: new Map() };
    this.records().forEach(record => addRecord(view, record));
    if (this.message) addRecord(view, { message: this.message, id: 'live' }, true);
    addLiveTools(view, this.tools);
    const used = new Set();
    const components = view.entries.map(entry => {
      used.add(entry.id);
      return this.#component(entry);
    });
    for (const key of this.cache.keys()) if (!used.has(key)) this.cache.delete(key);
    return components;
  }
  #component(entry) {
    const value = entry.kind === 'tool' ? { ...entry.value, result: displayResult(entry.value.result) } : entry.value;
    const signature = JSON.stringify([value, entry.streaming]);
    const cached = this.cache.get(entry.id);
    if (cached?.signature === signature) return cached.component;
    let component = cached?.component;
    if (entry.kind === 'assistant') {
      component ??= new this.sdk.AssistantMessageComponent(undefined, true, undefined, '', 0);
      component.updateContent(entry.value, entry.streaming);
    } else if (entry.kind === 'user') component = new this.sdk.UserMessageComponent(entry.value, undefined, 0);
    else component = this.#toolComponent(component, value);
    this.cache.set(entry.id, { signature, component });
    return component;
  }
  #toolComponent(component, tool) {
    const name = cleanText(tool.toolName ?? 'tool');
    if (!component)
      component = new this.sdk.ToolExecutionComponent(
        name,
        tool.toolCallId,
        cleanValue(tool.args ?? {}),
        { showImages: false },
        this.toolRenderers(name),
        this.tui,
        this.cwd,
      );
    else component.updateArgs(cleanValue(tool.args ?? {}));
    const running = this.tools.has(tool.toolCallId);
    if (tool.argsComplete || tool.finished || running) component.setArgsComplete();
    if (tool.finished || running) component.markExecutionStarted();
    if (tool.result || tool.finished)
      component.updateResult(
        { ...cleanValue(tool.result ?? { content: [] }), isError: !!tool.isError },
        !tool.finished,
      );
    component.setExpanded(this.expanded);
    return component;
  }
  render(width) {
    // Native user/assistant components emit shell-integration zones for the
    // main transcript. A clipped overlay must not introduce prompt/command
    // boundaries into the terminal (including after fullscreen's own filter).
    // Keep SGR colors and OSC 8 links intact, and never mutate native caches.
    return this.components()
      .flatMap(component => component.render(Math.max(1, width)))
      .map(line => line.replace(/\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ''));
  }
  invalidate() {
    for (const { component } of this.cache.values()) component.invalidate();
  }
}
