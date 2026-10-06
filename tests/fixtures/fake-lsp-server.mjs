import { appendFileSync } from 'node:fs';

let buffer = Buffer.alloc(0);
let nextId = 1000;
const cancelled = new Set();
const pending = new Map();
const slowRequests = new Map();
const diagnosticTimers = new Map();
const openDocuments = new Set();
let previousProbeDiagnostics;
const logPath = process.env.FAKE_LSP_LOG;

function log(event) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function request(method, params) {
  const id = nextId++;
  log({ method, params, id, direction: 'server-to-client' });
  send({ id, method, params });
  return new Promise(resolve => pending.set(id, resolve));
}

function clearDiagnosticTimers(uri) {
  for (const timer of diagnosticTimers.get(uri) ?? []) clearTimeout(timer);
  diagnosticTimers.delete(uri);
}

function publishFreshDiagnostics(uri, text) {
  let diagnostics;
  if (text.includes('pi-code-nav diagnostic probe')) {
    const markerIndex = text.indexOf('pi-code-nav diagnostic probe');
    if (text.lastIndexOf('/*', markerIndex) > text.lastIndexOf('*/', markerIndex)) {
      send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
      return;
    }
    const markerLineStart = text.lastIndexOf('\n', markerIndex) + 1;
    const markerText = text.slice(markerLineStart, markerIndex);
    const grammarProbe = markerText.startsWith('break;');
    const line = text.slice(0, markerLineStart).split('\n').length - 1;
    if (grammarProbe && process.env.FAKE_SKIP_GRAMMAR_PROBE === '1') {
      send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
      return;
    }
    const token = grammarProbe ? 'break;' : 'const = ;';
    const code = grammarProbe ? 1105 : 1134;
    const offset = grammarProbe ? 0 : 6;
    diagnostics = [];
    for (let start = markerText.indexOf(token); start >= 0; start = markerText.indexOf(token, start + token.length)) {
      diagnostics.push({
        severity: 1,
        source: 'fake',
        code,
        message: 'probe diagnostic',
        range: { start: { line, character: start + offset }, end: { line, character: start + offset + 1 } },
      });
    }
    const eofCode = Number(process.env.FAKE_PROBE_EOF_CODE ?? 0);
    if (eofCode > 0) {
      diagnostics.push({
        severity: 1,
        source: 'fake',
        code: eofCode,
        message: 'Unterminated source construct.',
        range: { start: { line: line + 1, character: 0 }, end: { line: line + 1, character: 1 } },
      });
    }
    if (process.env.FAKE_DIAGNOSTICS_EMPTY !== '1' && process.env.FAKE_SKIP_NON_PROBE_FRESH !== '1') {
      diagnostics.unshift({
        severity: 1,
        source: 'fake',
        code: 42,
        message: 'fresh diagnostic',
        range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
      });
    }
    const staleDelay = Number(process.env.FAKE_PROBE_STALE_AFTER_MS ?? 0);
    if (staleDelay > 0) {
      setTimeout(
        () =>
          send({
            method: 'textDocument/publishDiagnostics',
            params: {
              uri,
              diagnostics: [
                {
                  severity: 2,
                  message: 'stale diagnostic',
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                },
              ],
            },
          }),
        staleDelay,
      );
    }
  } else if (process.env.FAKE_DIAGNOSTICS_EMPTY === '1') diagnostics = [];
  else
    diagnostics = [
      {
        severity: 1,
        source: 'fake',
        code: 42,
        message: 'fresh diagnostic',
        range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
      },
    ];
  if (text.includes('pi-code-nav diagnostic probe') && process.env.FAKE_REPLAY_PREVIOUS_PROBE === '1') {
    if (previousProbeDiagnostics) {
      send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: previousProbeDiagnostics } });
      return;
    }
    previousProbeDiagnostics = structuredClone(diagnostics);
  }
  send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
}

function diagnostics(uri, previousGeneration, text) {
  // A change can have an already queued, unversioned publication from the old
  // generation. A newly opened document has no older generation to publish.
  if (previousGeneration) {
    send({
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        diagnostics: [
          {
            severity: 2,
            message: 'stale diagnostic',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        ],
      },
    });
  }
  clearDiagnosticTimers(uri);
  if (process.env.FAKE_DIAGNOSTICS_SKIP_FRESH === '1') return;
  if (process.env.FAKE_SKIP_NON_PROBE_FRESH === '1' && !text.includes('pi-code-nav diagnostic probe')) return;
  const progressiveDelay = Number(process.env.FAKE_DIAGNOSTICS_PROGRESSIVE_DELAY ?? 0);
  const timers = [];
  if (progressiveDelay > 0) {
    timers.push(
      setTimeout(
        () =>
          send({
            method: 'textDocument/publishDiagnostics',
            params: { uri, diagnostics: [] },
          }),
        Number(process.env.FAKE_DIAGNOSTICS_DELAY ?? 5),
      ),
    );
    timers.push(setTimeout(() => publishFreshDiagnostics(uri, text), progressiveDelay));
  } else {
    timers.push(setTimeout(() => publishFreshDiagnostics(uri, text), Number(process.env.FAKE_DIAGNOSTICS_DELAY ?? 5)));
  }
  diagnosticTimers.set(uri, timers);
}

async function handle(message) {
  if ('method' in message) log({ method: message.method, params: message.params, id: message.id });
  if (message.method === '$/cancelRequest') {
    cancelled.add(message.params.id);
    const slow = slowRequests.get(message.params.id);
    if (slow?.respondOnCancel) {
      clearTimeout(slow.timer);
      slowRequests.delete(message.params.id);
      send({ id: message.params.id, error: { code: -32800, message: 'Request cancelled' } });
    }
    log({ cancelled: message.params.id });
    return;
  }
  if (!('method' in message)) {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.id === undefined) {
    if (message.method === 'initialized') {
      const values = await Promise.all([
        request('workspace/configuration', { items: [{ section: 'typescript' }] }),
        request('client/registerCapability', { registrations: [] }),
        request('workspace/workspaceFolders'),
      ]);
      log({ clientResponses: values });
    }
    if (message.method === 'textDocument/didOpen') {
      openDocuments.add(message.params.textDocument.uri);
      diagnostics(message.params.textDocument.uri, false, message.params.textDocument.text);
    }
    if (message.method === 'textDocument/didChange')
      diagnostics(message.params.textDocument.uri, true, message.params.contentChanges[0].text);
    if (message.method === 'textDocument/didClose') {
      const uri = message.params.textDocument.uri;
      openDocuments.delete(uri);
      clearDiagnosticTimers(uri);
      if (process.env.FAKE_OMIT_CLOSE_DIAGNOSTICS !== '1') {
        setTimeout(
          () =>
            send({
              method: 'textDocument/publishDiagnostics',
              params: { uri, diagnostics: [] },
            }),
          Number(process.env.FAKE_CLOSE_DIAGNOSTICS_DELAY ?? 0),
        );
      }
    }
    if (message.method === 'exit') process.exit(0);
    return;
  }

  const respond = result => send({ id: message.id, result });
  if (message.method === 'initialize')
    return respond({
      capabilities: {
        textDocumentSync: 1,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        hoverProvider: true,
      },
    });
  if (message.method === 'shutdown') return respond(null);
  if (message.method === 'textDocument/documentSymbol')
    return respond([
      {
        name: 'outer',
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        children: [
          {
            name: 'inner',
            kind: 12,
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } },
            selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } },
          },
        ],
      },
    ]);
  if (message.method === 'workspace/symbol' && message.params.query === 'crash') return process.exit(17);
  if (message.method === 'workspace/symbol' && openDocuments.size === 0) {
    return send({ id: message.id, error: { code: -32603, message: 'No Project' } });
  }
  if (message.method === 'workspace/symbol')
    return respond([
      {
        name: `workspace:${message.params.query}`,
        kind: 12,
        location: {
          uri: message.params.query.includes('many')
            ? 'file:///tmp/many.ts'
            : message.params.query.includes('crash')
              ? 'file:///tmp/crash.ts'
              : message.params.query.includes('normal')
                ? 'file:///tmp/normal.ts'
                : message.params.query.includes('x')
                  ? 'file:///tmp/x.ts'
                  : 'file:///tmp/result.ts',
          range: { start: { line: 2, character: 3 }, end: { line: 2, character: 4 } },
        },
      },
      ...Array.from({ length: message.params.query === 'many' ? 30 : 0 }, (_, index) => ({
        name: `item${index}`,
        kind: 13,
        location: {
          uri: 'file:///tmp/many.ts',
          range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
        },
      })),
    ]);
  if (message.method === 'textDocument/definition')
    return respond({
      uri: message.params.textDocument.uri,
      range: { start: { line: 3, character: 4 }, end: { line: 3, character: 8 } },
    });
  if (message.method === 'textDocument/references')
    return respond([
      {
        uri: message.params.textDocument.uri,
        range: { start: { line: 5, character: 6 }, end: { line: 5, character: 9 } },
      },
    ]);
  if (message.method === 'textDocument/hover') {
    if (message.params.position.line === 97 || message.params.position.line === 98) {
      const timer = setTimeout(() => {
        slowRequests.delete(message.id);
        if (!cancelled.has(message.id)) respond({ contents: 'too late' });
      }, 500);
      slowRequests.set(message.id, { timer, respondOnCancel: message.params.position.line === 98 });
      return;
    }
    return respond({
      contents: { kind: 'markdown', value: '**number**' },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    });
  }
  send({ id: message.id, error: { code: -32601, message: `unsupported ${message.method}` } });
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const boundary = buffer.indexOf('\r\n\r\n');
    if (boundary < 0) return;
    const header = buffer.subarray(0, boundary).toString();
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    if (buffer.length < boundary + 4 + length) return;
    const body = buffer.subarray(boundary + 4, boundary + 4 + length);
    buffer = buffer.subarray(boundary + 4 + length);
    handle(JSON.parse(body.toString())).catch(error => {
      process.stderr.write(`${error.stack}\n`);
      process.exit(3);
    });
  }
});
process.stderr.write('fake stderr '.repeat(3000));
