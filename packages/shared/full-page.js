const fullPage = { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'top-left', margin: 0 } };
const masks = new WeakMap();

function maskTranscriptImages(tui) {
  // Minimal UI doubles and non-terminal clients may not expose the compositor.
  if (typeof tui.compositeOverlays !== 'function') return () => {};
  let mask = masks.get(tui);
  if (!mask) {
    const descriptor = Object.getOwnPropertyDescriptor(tui, 'compositeOverlays');
    const composite = tui.compositeOverlays;
    // Scoped workaround for Pi 0.99.2's protected compositor hook: it deliberately
    // passes image lines through unchanged. Both native renderers use this hook
    // (fullscreen bypasses root render()). Blank image lines before compositing,
    // retaining reserved rows/cached data. Native redraw removes old graphics.
    // No global capability changes, transcript mutations or focus replacement.
    tui.compositeOverlays = function (lines, width, height) {
      const masked = lines.map(line => (line.includes('\x1b_G') || line.includes('\x1b]1337;File=') ? '' : line));
      return composite.call(this, masked, width, height);
    };
    mask = {
      count: 0,
      restore() {
        if (descriptor) Object.defineProperty(tui, 'compositeOverlays', descriptor);
        else delete tui.compositeOverlays;
        masks.delete(tui);
        tui.requestRender(true);
      },
    };
    masks.set(tui, mask);
    tui.requestRender(true);
  }
  mask.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--mask.count === 0) mask.restore();
  };
}

export async function showFullPage(ctx, factory) {
  let release = () => {};
  try {
    return await ctx.ui.custom((tui, theme, keybindings, done) => {
      release = maskTranscriptImages(tui);
      return factory(tui, theme, keybindings, done);
    }, fullPage);
  } finally {
    release();
  }
}

/** Header, body clipped to the remaining rows, blank filler, then footer pinned to the bottom. */
export function fullPageLines(header, body, footer, height) {
  const room = Math.max(0, height - header.length - footer.length);
  const filler = Array(Math.max(0, room - body.length)).fill('');
  return [...header, ...body.slice(0, room), ...filler, ...footer].slice(0, height);
}
