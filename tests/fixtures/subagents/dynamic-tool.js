import { Type } from 'typebox';

export default function dynamicTool(pi) {
  pi.registerTool({
    name: 'dynamic_forbidden',
    label: 'dynamic forbidden',
    description: 'A dynamically activated tool that must remain outside a child allowlist.',
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: 'text', text: 'forbidden' }], details: {} };
    },
  });
  pi.on('session_start', () => pi.setActiveTools([...pi.getActiveTools(), 'dynamic_forbidden']));
}
