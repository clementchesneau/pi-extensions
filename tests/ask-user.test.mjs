import assert from 'node:assert/strict';
import test from 'node:test';
import { ScrollView, Text, TuiAltScreen, TuiMainScreen, VStack, visibleWidth } from '@earendil-works/pi-tui';
import askUser from '../packages/ask-user/index.js';
import { createFakePi } from './fixtures/fake-pi.mjs';

const questions = [
  {
    id: 'scope',
    prompt: 'Quel périmètre ?',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  },
  {
    id: 'features',
    prompt: 'Quelles fonctionnalités ?',
    multiple: true,
    options: [
      { value: 'x', label: 'X' },
      { value: 'y', label: 'Y' },
    ],
  },
];
const theme = { fg: (_color, text) => text, bold: text => text };
function interaction(qs = questions, signal, rows = 24) {
  let component;
  let customOptions;
  let settled = false;
  const terminal = { rows };
  const promise = tool()
    .execute('id', { questions: qs }, signal, undefined, {
      mode: 'tui',
      ui: {
        custom: (factory, options) =>
          new Promise(resolve => {
            customOptions = options;
            component = factory({ requestRender() {}, terminal }, theme, {}, resolve);
            component.focused = true;
          }),
      },
    })
    .then(value => {
      settled = true;
      return value;
    });
  return {
    promise,
    terminal,
    get customOptions() {
      return customOptions;
    },
    get component() {
      return component;
    },
    get settled() {
      return settled;
    },
    key: data => component.handleInput(data),
  };
}
function tool() {
  const fake = createFakePi();
  askUser(fake.pi);
  return fake.tools.get('ask_user');
}

test('ask_user is model-only, sequential, and reports unavailable without opening UI', async () => {
  const registered = tool();
  assert.equal(registered.name, 'ask_user');
  assert.equal(registered.exposure, 'model-only');
  assert.equal(registered.executionMode, 'sequential');
  for (const mode of ['rpc', 'json', 'print']) {
    const result = await registered.execute('id', { questions }, undefined, undefined, {
      mode,
      ui: {
        custom() {
          assert.fail('No terminal UI');
        },
      },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.details, { status: 'unavailable', answers: [] });
  }
});

test('questionnaire uses the inline editor area, stays compact and grows only with content', async () => {
  const ui = interaction([questions[0]], undefined, 80);
  assert.notEqual(ui.customOptions?.overlay, true, 'Keep the transcript visible rather than using an overlay');
  const lines = ui.component.render(80);
  assert.ok(lines.length <= 12, `Simple question should be compact, got ${lines.length} rows`);
  assert.match(lines.join('\n'), /Quel périmètre/);
  assert.match(lines.join('\n'), /Other answer/);
  assert.match(lines.join('\n'), /Esc cancel/);
  ui.key('\x1b');
  await ui.promise;
});

test('long inline content is bounded while choices and summary remain scrollable', async () => {
  const qs = Array.from({ length: 6 }, (_unused, i) => ({
    id: `q${i}`,
    prompt: `Question ${i} ` + 'Longue question '.repeat(40),
    options: [
      { value: 'a', label: 'Début', description: 'Explication '.repeat(80) },
      { value: 'b', label: 'Fin' },
    ],
  }));
  const ui = interaction(qs);
  for (const rows of [16, 24, 40, 80]) {
    ui.terminal.rows = rows;
    const lines = ui.component.render(80);
    assert.ok(lines.length <= Math.min(16, rows / 2), `Must leave room for thread at ${rows} rows`);
  }
  ui.key('\x1b[B');
  assert.match(ui.component.render(80).join('\n'), /Fin/);
  for (let i = 0; i < qs.length; i++) ui.key('2');
  const start = ui.component.render(80).join('\n');
  assert.match(start, /Summary/);
  assert.match(start, /Question 0/);
  ui.key('\x1b[6~');
  assert.notEqual(ui.component.render(80).join('\n'), start);
  ui.key('\x1b');
  await ui.promise;
});

test('free text is edited directly in the Other row while the question and choices remain visible', async () => {
  for (const multiple of [false, true]) {
    const ui = interaction([{ ...questions[0], multiple }]);
    if (multiple) ui.key('1');
    ui.key('3');
    ui.key('Ma réponse');
    const lines = ui.component.render(80);
    assert.match(lines.join('\n'), /Quel périmètre/);
    assert.ok(lines.some(line => /1\. A/.test(line)));
    assert.ok(lines.some(line => /2\. B/.test(line)));
    const inputRow = lines.find(line => line.includes('Ma réponse'));
    assert.match(inputRow, /3\. Other answer.*Ma réponse/);
    assert.match(inputRow, /\x1b_pi:c\x07/);
    assert.ok(lines.length <= 12);
    ui.key('\n'); // multiline input still uses the native editor
    ui.key('Deuxième ligne');
    for (const width of [1, 12, 40, 80]) {
      const rendered = ui.component.render(width);
      assert.ok(rendered.every(line => visibleWidth(line) <= width));
      assert.match(rendered.join('\n'), /\x1b_pi:c\x07/);
    }
    ui.key('\r');
    if (multiple) ui.key('\r');
    ui.key('\r');
    const answer = (await ui.promise).details.answers[0];
    assert.equal(answer.custom, 'Ma réponse\nDeuxième ligne');
    assert.deepEqual(answer.selected, multiple ? [{ value: 'a', label: 'A' }] : []);
  }
});

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
  test(`${Renderer.name}: terminal-routed scrolling reaches summary and long questions during free-text editing`, async t => {
    let input;
    const terminal = {
      rows: 24,
      columns: 80,
      write() {},
      start: onInput => {
        input = onInput;
      },
      stop() {},
      hideCursor() {},
      showCursor() {},
      moveTo() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
    };
    const tui = new Renderer(terminal);
    t.after(() => tui.stop());
    const document = new Text(Array.from({ length: 60 }, (_unused, i) => `Thread line ${i}`).join('\n'), 0, 0);
    const qs = Array.from({ length: 8 }, (_unused, i) => ({
      id: `q${i}`,
      prompt: `Question initiale ${i} ` + 'long texte '.repeat(80),
      options: [
        { value: 'a', label: i === 7 ? 'Dernière réponse' : 'A' },
        { value: 'b', label: 'B' },
      ],
    }));
    let component;
    const pending = tool().execute('id', { questions: qs }, undefined, undefined, {
      mode: 'tui',
      ui: {
        custom: factory =>
          new Promise(resolve => {
            component = factory(tui, theme, {}, value => {
              component.dispose();
              resolve(value);
            });
            // Same native layout as Pi: primary scrollable transcript above fixed input dock.
            if (tui.mode === 'fullscreen')
              tui.setLayoutRoot(
                new VStack([
                  {
                    component: new ScrollView(document, { follow: 'end', primary: true }),
                    basis: 0,
                    grow: 1,
                    minSize: 1,
                  },
                  { component, basis: 'auto', grow: 0, shrink: 1, minSize: 3 },
                ]),
              );
            else {
              tui.addChild(document);
              tui.addChild(component);
            }
            tui.setFocus(component);
          }),
      },
    });
    tui.start();
    const key = data => {
      input(data);
      tui.renderNow();
    };
    tui.renderNow();
    key('3');
    key('Réponse conservée 🐈');
    const editing = component.render(80).join('\n');
    assert.doesNotMatch(editing, /Question initiale 0/);
    const viewport = tui.viewportTop;
    key('\x1b[1;3A'); // Option/Alt+Up, through the actual renderer's input listeners
    key('\x1b[1;3A');
    assert.match(component.render(80).join('\n'), /Question initiale 0/);
    if (tui.mode === 'fullscreen') assert.equal(tui.viewportTop, viewport, 'Panel scroll must not move the transcript');
    key('\x1b[1;3B');
    key('\x1b[1;3B');
    assert.match(component.render(80).join('\n'), /Réponse conservée/);
    // Regular mode PageUp/PageDown also scroll the panel while editing.
    if (tui.mode === 'regular') {
      key('\x1b[5~');
      key('\x1b[5~');
      assert.match(component.render(80).join('\n'), /Question initiale 0/);
    }
    key('\r');
    for (let i = 1; i < qs.length; i++) key('1');
    assert.match(component.render(80).join('\n'), /Summary/);
    const before = component.render(80).join('\n');
    if (tui.mode === 'fullscreen') {
      const threadPosition = tui.viewportTop;
      key('\x1b[5~');
      assert.equal(component.render(80).join('\n'), before, 'Native fullscreen PageUp belongs to transcript');
      assert.ok(tui.viewportTop < threadPosition);
      key('\x1b[6~');
    }
    key('\x1b[1;3B');
    assert.notEqual(component.render(80).join('\n'), before);
    let traversed = '';
    for (let i = 0; i < 50; i++) {
      key('\x1b[1;3B');
      traversed += component.render(80).join('\n');
    }
    assert.match(traversed, /Question initiale 7/);
    assert.match(component.render(80).join('\n'), /Dernière réponse/);
    key('\r');
    const result = await pending;
    assert.equal(result.details.status, 'answered');
    assert.equal(result.details.answers[0].custom, 'Réponse conservée 🐈');
  });
}

test('single and multiple choices can be revised, supplemented and submitted only from summary', async () => {
  const ui = interaction();
  ui.key('2');
  ui.key('1');
  ui.key('2');
  ui.key('3'); // Other
  ui.key('Précision libre');
  ui.key('\r'); // save custom answer
  ui.key('\r'); // continue multiple question
  assert.match(ui.component.render(80).join(' '), /Summary/);
  assert.equal(ui.settled, false);
  ui.key('\x1b[D'); // back to features
  ui.key('1'); // uncheck X
  ui.key('\x1b[D'); // back to scope
  ui.key('1'); // replace B by A
  ui.key('\r'); // features -> summary, preserve Y and custom text
  ui.key('\r'); // submit
  const result = await ui.promise;
  assert.equal(result.details.status, 'answered');
  assert.deepEqual(result.details.answers, [
    { id: 'scope', prompt: questions[0].prompt, selected: [{ value: 'a', label: 'A' }], custom: null },
    { id: 'features', prompt: questions[1].prompt, selected: [{ value: 'y', label: 'Y' }], custom: 'Précision libre' },
  ]);
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});

test('Escape discards partial answers, including while typing and on summary', async () => {
  for (const state of ['options', 'editor', 'summary']) {
    const ui = interaction();
    ui.key('1');
    if (state === 'editor') {
      ui.key('3');
      ui.key('Un texte non validé');
    }
    if (state === 'summary') {
      ui.key('1');
      ui.key('\r');
    }
    ui.key('\x1b');
    assert.deepEqual((await ui.promise).details, { status: 'cancelled', answers: [] });
  }
});

test('abort and session shutdown close pending UI without forwarding drafts', async () => {
  const controller = new AbortController();
  const ui = interaction(questions, controller.signal);
  ui.key('1');
  controller.abort();
  assert.deepEqual((await ui.promise).details, { status: 'cancelled', answers: [] });
  const stopped = new AbortController();
  stopped.abort();
  const result = await tool().execute('id', { questions }, stopped.signal, undefined, { mode: 'tui' });
  assert.equal(result.details.status, 'cancelled');
  let component;
  const fake = createFakePi();
  askUser(fake.pi);
  const pending = fake.tools.get('ask_user').execute('id', { questions }, undefined, undefined, {
    mode: 'tui',
    ui: {
      custom: factory =>
        new Promise(resolve => {
          component = factory({ requestRender() {} }, theme, {}, resolve);
        }),
    },
  });
  component.handleInput('1');
  await fake.fire('session_shutdown');
  assert.deepEqual((await pending).details, { status: 'cancelled', answers: [] });
});

test('empty answers cannot be submitted and a free-text single answer replaces the option', async () => {
  const ui = interaction([questions[0]]);
  ui.key('\x1b[C');
  assert.match(ui.component.render(80).join(' '), /Choose an option/);
  ui.key('3');
  ui.key('\r'); // empty -> stay on question, not a synthetic answer
  assert.match(ui.component.render(80).join(' '), /Question 1/);
  ui.key('1'); // A -> summary
  ui.key('\x1b[D');
  ui.key('3');
  ui.key('Ma propre réponse');
  ui.key('\r');
  ui.key('\r');
  assert.deepEqual((await ui.promise).details.answers[0], {
    id: 'scope',
    prompt: questions[0].prompt,
    selected: [],
    custom: 'Ma propre réponse',
  });
});

test('render fits narrow terminals and resize, scrolls long options and preserves editor focus', async () => {
  const long = [
    {
      ...questions[0],
      prompt: 'Une question 🐈 très longue '.repeat(30),
      options: [
        { value: 'a', label: 'Première', description: 'Explication '.repeat(80) },
        { value: 'b', label: 'Dernière 🐈' },
      ],
    },
  ];
  const ui = interaction(long);
  for (const width of [0, 1, 12, 40, 80, 120]) {
    const lines = ui.component.render(width);
    assert.ok(lines.length <= 24);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  ui.key('\x1b[B');
  assert.match(ui.component.render(40).join(' '), /Dernière/);
  ui.key('3');
  assert.match(ui.component.render(80).join(' '), /\x1b_pi:c\x07/);
  ui.component.focused = false;
  assert.doesNotMatch(ui.component.render(80).join(' '), /\x1b_pi:c\x07/);
  ui.component.focused = true;
  ui.key('\x1b');
  await ui.promise;
});

test('Unicode free text renders safely across narrow fields and survives resize and submission', async () => {
  for (const multiple of [false, true]) {
    for (const text of ['🐈', '漢字', '🐈\n漢字 é 👨‍👩‍👧‍👦']) {
      const ui = interaction([{ ...questions[0], multiple }]);
      ui.key('3');
      ui.key(`\x1b[200~${text}\x1b[201~`);
      for (let width = 1; width <= 40; width++) {
        let lines;
        assert.doesNotThrow(() => {
          lines = ui.component.render(width);
        }, `multiple=${multiple}, width=${width}, text=${text}`);
        assert.ok(lines.every(line => visibleWidth(line) <= width));
        assert.match(lines.join('\n'), /\x1b_pi:c\x07/, 'Keep the focused cursor visible');
      }
      ui.key('\r');
      if (multiple) ui.key('\r');
      ui.key('\r');
      assert.equal((await ui.promise).details.answers[0].custom, text);
    }
  }
});

test('terminal control sequences in questions and choices are rendered as data', async () => {
  const ui = interaction([
    { id: 'test', prompt: 'Hello\x1b[2J', options: [{ value: 'a', label: 'A\x1b]52;c;secret\x07' }] },
  ]);
  const lines = ui.component.render(80).join('\n');
  assert.doesNotMatch(lines, /\x1b\[2J|\x1b\]52/);
  ui.key('\x1b');
  await ui.promise;
});

test('result renderer preserves actual validation and UI errors instead of reporting unavailability', async () => {
  const registered = tool();
  const invalid = [{ ...questions[0], options: [{ value: 'a', label: '  ' }] }];
  let validation;
  try {
    await registered.execute('id', { questions: invalid }, undefined, undefined, { mode: 'tui' });
  } catch (error) {
    validation = error.message;
  }
  assert.match(validation, /Invalid questionnaire/);
  for (const details of [{}, undefined, { status: 'unknown' }]) {
    for (const message of [validation, 'Failed to open UI\x1b[2J']) {
      const rendered = registered
        .renderResult({ content: [{ type: 'text', text: message }], details }, {}, theme, { isError: true })
        .render(80)
        .join('\n');
      assert.match(rendered, /Invalid questionnaire|Failed to open UI/);
      assert.doesNotMatch(rendered, /unavailable|\x1b\[2J/);
    }
  }
  const pending = registered
    .renderResult({ content: [{ type: 'text', text: 'En cours' }], details: {} }, {}, theme, { isError: false })
    .render(80)
    .join('\n');
  assert.match(pending, /En cours/);
  assert.doesNotMatch(pending, /unavailable/);
  const unavailable = await registered.execute('id', { questions }, undefined, undefined, { mode: 'rpc' });
  assert.match(registered.renderResult(unavailable, {}, theme, { isError: true }).render(80).join('\n'), /unavailable/);
});

test('rejects empty questions, whitespace labels and duplicate identifiers before opening UI', async () => {
  for (const invalid of [
    [],
    [questions[0], questions[0]],
    [{ ...questions[0], prompt: '  ' }],
    [{ ...questions[0], options: [] }],
    [{ ...questions[0], options: [{ value: 'a', label: ' ' }] }],
    [
      {
        ...questions[0],
        options: [
          { value: 'a', label: 'A' },
          { value: 'a', label: 'B' },
        ],
      },
    ],
  ]) {
    await assert.rejects(
      tool().execute('id', { questions: invalid }, undefined, undefined, {
        mode: 'tui',
        ui: {
          custom() {
            assert.fail('Invalid questions must not open UI');
          },
        },
      }),
      /Invalid questionnaire/,
    );
  }
});
