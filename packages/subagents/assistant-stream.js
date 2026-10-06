// Applies one assistantMessageEvent to the content blocks of the message being streamed.
// No prototype: an unknown event type must not resolve to an inherited method.
const CONTENT_UPDATES = {
  __proto__: null,
  text_start(content, index) {
    content[index] = { type: 'text', text: '' };
  },
  text_delta(content, index, update) {
    const block = content[index] ?? { type: 'text', text: '' };
    content[index] = { ...block, text: (block.text ?? '') + update.delta };
  },
  text_end(content, index, update) {
    content[index] = { type: 'text', text: update.content };
  },
  thinking_start(content, index) {
    content[index] = { type: 'thinking', thinking: '' };
  },
  thinking_delta(content, index, update) {
    const block = content[index] ?? { type: 'thinking', thinking: '' };
    content[index] = { ...block, thinking: (block.thinking ?? '') + update.delta };
  },
  thinking_end(content, index, update) {
    content[index] = { type: 'thinking', thinking: update.content };
  },
  toolcall_start(content, index, update) {
    content[index] = { type: 'toolCall', id: update.id, name: update.toolName, arguments: {}, partialJson: '' };
  },
  toolcall_delta(content, index, update) {
    const block = content[index];
    if (block?.type !== 'toolCall') return;
    block.partialJson = (block.partialJson ?? '') + update.delta;
    // Do not invent a second partial-JSON parser. Until valid JSON arrives,
    // native cards show the call as still being generated; *_end is authoritative.
    try {
      block.arguments = JSON.parse(block.partialJson);
    } catch {}
  },
  toolcall_end(content, index, update) {
    content[index] = structuredClone(update.toolCall);
  },
};

// RPC updates omit cumulative message snapshots. Reconstruct their content once
// for both the reopenable live state and the native Activity transcript.
export function updateAssistantMessage(message, data) {
  const snapshot = data.message ?? data.assistantMessageEvent?.partial;
  if (snapshot?.role === 'assistant') return structuredClone(snapshot);
  if (data.type !== 'message_update') return message;
  const update = data.assistantMessageEvent;
  message ??= { role: 'assistant', content: [] };
  message.content ??= [];
  if (data.usage !== undefined) message.usage = structuredClone(data.usage);
  CONTENT_UPDATES[update?.type]?.(message.content, update?.contentIndex ?? 0, update);
  return message;
}
