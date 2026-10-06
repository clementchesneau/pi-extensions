import { createServer } from 'node:http';

// Local deterministic OpenAI-compatible fixture. No network model or credentials.
const server = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  const messages = JSON.stringify(payload.messages);
  const child = messages.includes('Delegated mission');
  const slow = child && messages.includes('slow evidence');
  const hasToolOutput = payload.messages.some(message => message.role === 'tool');
  if (child && (!slow || hasToolOutput)) await new Promise(resolve => setTimeout(resolve, slow ? 10_000 : 1_000));
  const hasResults = messages.includes('Result available (unverified)');
  const launch =
    !child &&
    messages.includes('DEMO_START') &&
    !payload.messages.some(message => message.role === 'tool') &&
    !hasResults;
  const delta = launch
    ? {
        role: 'assistant',
        tool_calls: ['slow', 'fast'].map((name, index) => ({
          index,
          id: name,
          type: 'function',
          function: {
            name: 'subagent_start',
            arguments: JSON.stringify({
              title: `${name} evidence`,
              task: `${name} evidence`,
              context: 'Read-only deterministic demo; do not change files',
            }),
          },
        })),
      }
    : slow && !hasToolOutput
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'demo-read',
              type: 'function',
              function: { name: 'read', arguments: JSON.stringify({ path: 'README.md' }) },
            },
          ],
        }
      : {
          role: 'assistant',
          content: child
            ? 'Deterministic child evidence (available, not verified)'
            : hasResults
              ? 'Parent saw delegated evidence.'
              : 'Parent is working independently.',
        };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({ id: 'demo', object: 'chat.completion.chunk', created: 1, model: 'deterministic', choices: [{ index: 0, delta, finish_reason: launch || (slow && !hasToolOutput) ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
  );
  response.end();
});
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/v1`));
