import assert from 'node:assert/strict';
import test from 'node:test';
import { Image, TuiAltScreen, TuiMainScreen, getCapabilities, setCapabilities } from '@earendil-works/pi-tui';
import { showFullPage } from '../packages/shared/full-page.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWoQAAAAASUVORK5CYII=';

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
  test(`${Renderer.name} deletes visible graphics while a full page is open, then redraws the image`, async t => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, images: 'kitty' });
    let output = '';
    const terminal = {
      rows: 20,
      columns: 80,
      write(data) {
        output += data;
      },
      start() {},
      stop() {},
      hideCursor() {},
      showCursor() {},
      moveTo() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
    };
    const tui = new Renderer(terminal);
    t.after(() => {
      tui.stop();
      setCapabilities(capabilities);
    });
    tui.addChild(
      new Image(
        png,
        'image/png',
        { fallbackColor: text => text },
        { imageId: 42, maxWidthCells: 2, maxHeightCells: 2 },
      ),
    );
    tui.start();
    tui.renderNow();
    assert.match(output, /\x1b_G[^;]*a=T/);
    output = '';
    let close;
    const ctx = {
      ui: {
        custom: (factory, options) =>
          new Promise(resolve => {
            const component = factory(tui, {}, {}, value => {
              handle.hide();
              resolve(value);
            });
            const handle = tui.showOverlay(component, options.overlayOptions);
          }),
      },
    };
    const opened = showFullPage(ctx, (_tui, _theme, _keys, done) => {
      close = done;
      return { render: () => Array(terminal.rows).fill('VISIBLE PANEL'), invalidate() {} };
    });
    tui.renderNow();
    assert.match(output, /VISIBLE PANEL/);
    assert.doesNotMatch(output, /\x1b_G[^;]*a=[Tp]/);
    assert.match(output, /\x1b_G[^;]*a=d/, 'native renderer removes already visible placements');
    output = '';
    terminal.rows = 24;
    tui.renderNow();
    assert.doesNotMatch(output, /\x1b_G[^;]*a=[Tp]/);
    close();
    await opened;
    output = '';
    tui.renderNow();
    assert.match(output, /\x1b_G[^;]*a=[Tp]/);
    assert.equal(Object.hasOwn(tui, 'compositeOverlays'), false, 'inherited compositor restored');
    await tick();
  });
}

test('factory failure restores the compositor and overlapping screens keep masking until both close', async () => {
  const original = lines => lines;
  const tui = { compositeOverlays: original, requestRender() {} };
  const completions = [];
  const ctx = {
    ui: {
      custom: factory =>
        new Promise(resolve => {
          factory(tui, {}, {}, resolve);
          completions.push(resolve);
        }),
    },
  };
  await assert.rejects(
    showFullPage(ctx, () => {
      throw new Error('factory failed');
    }),
    /factory failed/,
  );
  assert.equal(tui.compositeOverlays, original);
  const first = showFullPage(ctx, () => ({}));
  const second = showFullPage(ctx, () => ({}));
  assert.deepEqual(tui.compositeOverlays(['\x1b_Gimage'], 80, 20), ['']);
  completions[0]();
  await first;
  assert.deepEqual(tui.compositeOverlays(['\x1b_Gimage'], 80, 20), ['']);
  completions[1]();
  await second;
  assert.equal(tui.compositeOverlays, original);
});
