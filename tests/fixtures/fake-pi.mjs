import { createEventBus } from '@earendil-works/pi-coding-agent';

/**
 * Minimal Pi extension API for tests: records what an extension registers and lets the test
 * fire lifecycle events. Pass `overrides` for the few methods a test needs to observe.
 */
export function createFakePi(overrides = {}) {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const entryRenderers = new Map();
  const messageRenderers = new Map();
  const entries = [];
  const messages = [];
  const pi = {
    events: createEventBus(),
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    registerEntryRenderer: (type, renderer) => entryRenderers.set(type, renderer),
    registerMessageRenderer: (customType, renderer) => messageRenderers.set(customType, renderer),
    appendEntry: (customType, data) => entries.push({ customType, data }),
    sendMessage: (message, options) => messages.push({ message, options }),
    sendUserMessage: (text, options) => messages.push({ text, options }),
    getSettings: () => ({}),
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...tools.keys()],
    getCommands: () => [],
    ...overrides,
  };
  return {
    pi,
    tools,
    commands,
    handlers,
    entryRenderers,
    messageRenderers,
    entries,
    messages,
    /**
     * Runs every handler of `name` in registration order and returns their results.
     * Throws when nothing handles `name`, so a test notices an extension that stopped listening.
     */
    async fire(name, event = {}, ctx = undefined) {
      const registered = handlers.get(name);
      if (!registered) throw new Error(`No handler registered for ${name}`);
      const results = [];
      for (const handler of registered) results.push(await handler(event, ctx));
      return results;
    },
  };
}
