import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const TIMEOUT = 10_000;
// Browsers live in Playwright's shared cache, one revision per Playwright version.
const INSTALL_CHROMIUM = `npx playwright@${createRequire(import.meta.url)('playwright/package.json').version} install chromium`;

// browser_act actions on a resolved unique target; each checks the parameters it needs.
const LOCATOR_ACTIONS = {
  __proto__: null,
  click: locator => locator.click(),
  fill(locator, { value }) {
    if (typeof value !== 'string') throw new Error('fill requires value.');
    return locator.fill(value);
  },
  press(locator, { key }) {
    if (typeof key !== 'string' || !key) throw new Error('press requires key.');
    return locator.press(key);
  },
  select(locator, { value }) {
    if (typeof value !== 'string') throw new Error('select requires value (option value).');
    return locator.selectOption(value);
  },
  check(locator, { checked }) {
    if (typeof checked !== 'boolean') throw new Error('check requires checked.');
    return locator.setChecked(checked);
  },
  hover: locator => locator.hover(),
  scroll: locator => locator.scrollIntoViewIfNeeded(),
  wait(locator, { state = 'visible' }) {
    if (!['visible', 'hidden'].includes(state)) throw new Error('wait state must be visible or hidden.');
    return locator.waitFor({ state });
  },
};

export class BrowserSession {
  browser;
  page;
  diagnostics = [];
  queue = Promise.resolve();

  // Pi may execute sibling tool calls concurrently. Keep page operations ordered.
  run(operation, signal) {
    const task = this.queue.then(async () => {
      signal?.throwIfAborted();
      let closing;
      const abort = () => {
        closing = this.close().catch(() => {});
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const result = await operation();
        signal?.throwIfAborted();
        return result;
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) {
          await closing;
          // Also handles cancellation during launch, before browser was assigned.
          await this.close();
        }
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async open({ url, width = 1280, height = 800 }, signal) {
    this.validateViewport(width, height);
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('browser_open requires an HTTP(S) URL without embedded credentials.');
    }
    if (this.browser && (!this.browser.isConnected() || this.page?.isClosed())) await this.close();
    if (!this.browser) {
      try {
        this.browser = await chromium.launch({ headless: true, timeout: TIMEOUT });
      } catch (error) {
        throw new Error(`Cannot launch Chromium. Install it with: ${INSTALL_CHROMIUM}`, { cause: error });
      }
      signal?.throwIfAborted();
      try {
        const context = await this.browser.newContext({ viewport: { width, height }, acceptDownloads: false });
        this.page = await context.newPage();
        this.page.on('console', message => {
          if (['warning', 'error'].includes(message.type())) this.record(message.type(), message.text());
        });
        this.page.on('pageerror', error => this.record('pageerror', error.message));
        this.page.on('requestfailed', request =>
          this.record('requestfailed', `${request.method()} ${request.url()} ${request.failure()?.errorText}`),
        );
        this.page.on('response', response => {
          if (response.status() >= 400) this.record('http', `${response.status()} ${response.url()}`);
        });
        this.page.setDefaultTimeout(TIMEOUT);
        this.page.setDefaultNavigationTimeout(TIMEOUT);
        // One isolated page, no inherited personal profile, permissions or popups.
        context.on('page', page => {
          if (page !== this.page) void page.close().catch(() => {});
        });
      } catch (error) {
        await this.close();
        throw error;
      }
    }
    await this.current().setViewportSize({ width, height });
    this.diagnostics = [];
    await this.page.goto(parsed.href, { waitUntil: 'domcontentloaded' });
    return this.inspect();
  }

  current() {
    if (!this.page || this.page.isClosed()) throw new Error('No browser page. Use browser_open first.');
    return this.page;
  }

  validateViewport(width, height) {
    if (
      !Number.isInteger(width) ||
      width < 240 ||
      width > 1920 ||
      !Number.isInteger(height) ||
      height < 240 ||
      height > 1440
    ) {
      throw new Error('Viewport requires width 240–1920 and height 240–1440.');
    }
  }

  locator(target) {
    const page = this.current();
    if (target?.selector && !target.role && target.name === undefined) return page.locator(target.selector);
    if (target?.role && !target.selector) {
      return page.getByRole(target.role, { name: target.name, exact: true });
    }
    throw new Error('Supply target with role/name OR selector, not both.');
  }

  async act(params) {
    const page = this.current();
    const { action, target, width, height } = params;
    if (action === 'resize') {
      this.validateViewport(width, height);
      await page.setViewportSize({ width, height });
    } else {
      const locator = this.locator(target);
      const perform = LOCATOR_ACTIONS[action];
      if (!perform) throw new Error(`Unknown browser action: ${action}`);
      await perform(locator, params);
    }
    return { action, url: page.url(), viewport: page.viewportSize() };
  }

  record(kind, text) {
    this.diagnostics.push({ kind, text: text.slice(0, 2000) });
    if (this.diagnostics.length > 50) this.diagnostics.shift();
  }

  /** @param {{ target?: { selector?: string, role?: string, name?: string }, screenshot?: boolean }} [options] */
  async inspect({ target, screenshot = false } = {}) {
    const page = this.current();
    const locator = target ? this.locator(target) : page.locator('body');
    let image;
    if (screenshot) {
      // Bounded viewport/component captures avoid giant full-page images in context.
      if (target) {
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox();
        if (!box || box.width > 1920 || box.height > 1440) {
          throw new Error('Component exceeds capture limits (1920×1440). Capture the viewport or a smaller target.');
        }
      }
      const options = { type: 'jpeg', quality: 80, animations: 'disabled', timeout: TIMEOUT, scale: 'css' };
      image = target ? await locator.screenshot(options) : await page.screenshot({ ...options, fullPage: false });
      if (image.length > 4 * 1024 * 1024) throw new Error('Capture exceeds 4 MiB. Use a smaller target or viewport.');
    }
    return {
      url: page.url(),
      title: await page.title(),
      viewport: page.viewportSize(),
      target,
      observedAt: new Date().toISOString(),
      snapshot: await locator.ariaSnapshot({ timeout: TIMEOUT }),
      diagnostics: [...this.diagnostics],
      image,
    };
  }

  async close() {
    const browser = this.browser;
    this.browser = undefined;
    this.page = undefined;
    this.diagnostics = [];
    await browser?.close();
  }
}
