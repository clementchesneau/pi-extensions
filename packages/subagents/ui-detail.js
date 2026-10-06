import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import { fullPageLines, showFullPage } from '@clement_chsn/pi-shared/full-page';
import { ActivityTranscript, TranscriptReader } from './transcript.js';
import { UNFINISHED_STATES } from './run-state.js';
import { createResponseRenderer, detailChrome, informationRows, TABS, trim, wrapRows } from './ui-detail-render.js';

const PAGE_BYTES = 8 * 1024;
const MAX_RESULT_CHARS = 24 * 1024;

/**
 * State of one agent's detail page: its activity transcript and final response, loaded by
 * bounded pages, and a scroll position per tab. Events arriving before the page is shown are
 * buffered, so nothing published between the snapshot and the first render is lost.
 */
class AgentDetail {
  #ctx;
  #manager;
  #sdk;
  #agentId;
  #alive;
  #reader = new TranscriptReader();
  #response = createResponseRenderer();
  #activity;
  #cursor = 0;
  #nextCursor;
  #resultText = '';
  #resultCursor;
  #resultNext;
  #resultLoadedRunId;
  #displayedRunId;
  #error = '';
  #discarded = false;
  #loading = Promise.resolve();
  #tab;
  #scroll = { response: 0, activity: 0, information: 0 };
  // null means activity has not had its initial layout yet; false is an
  // explicit reading position and must never be re-enabled by an event.
  #following = { response: false, activity: null, information: false };
  #width = 80;
  #bodyHeight = 16;
  #scrollVersion = 0;
  #paging = false;
  #closed = false;
  #page;
  #pendingMetadata = false;
  #pendingActivity = [];
  #dispatchMetadata = event => {
    if (event.agentId === this.#agentId) this.#pendingMetadata = true;
  };
  #dispatchActivity = event => {
    if (event.agentId === this.#agentId) this.#pendingActivity.push(event);
  };
  #unsubscribe;
  #refreshTimer;
  #detached = false;

  constructor({ ctx, manager, sdk, agentId, alive }) {
    this.#ctx = ctx;
    this.#manager = manager;
    this.#sdk = sdk;
    this.#agentId = agentId;
    this.#alive = alive;
    this.#activity = new ActivityTranscript({ sdk, cwd: ctx.cwd, expanded: ctx.ui.getToolsExpanded?.() ?? false });
    this.#tab = UNFINISHED_STATES.has(this.#agent()?.run?.state) ? 'activity' : 'response';
    this.#displayedRunId = this.#agent()?.run?.runId;
    // Subscribe before the synchronous snapshot and before any asynchronous archive/result reads.
    const detachMetadata = manager.subscribe(event => this.#dispatchMetadata(event));
    const detachActivity = manager.subscribeActivity?.(event => this.#dispatchActivity(event));
    this.#unsubscribe = () => {
      detachMetadata();
      detachActivity?.();
    };
    this.#activity.snapshot(manager.activitySnapshot?.(agentId));
  }

  detach() {
    if (this.#detached) return;
    this.#detached = true;
    this.#unsubscribe();
    clearInterval(this.#refreshTimer);
  }

  /** Loads the first pages; false when the UI went away meanwhile. */
  async prepare() {
    await this.#load();
    if (!this.#alive()) return false;
    this.#reconcileRun();
    do {
      await this.#fetchResult();
      if (!this.#alive()) return false;
      // A continuation can happen during any result read, not just the first.
    } while (this.#reconcileRun());
    return true;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.detach();
    this.#page.done(null);
  }

  /** Attaches the shown page and replays the events buffered until now. */
  attach(page) {
    this.#page = page;
    this.#activity.tui = page.tui;
    this.#dispatchMetadata = event => this.#onChange(event);
    this.#dispatchActivity = event => this.#onActivity(event);
    for (const event of this.#pendingActivity) this.#onActivity(event);
    this.#pendingActivity.length = 0;
    // Legacy managers without a live snapshot retain a modest archive fallback. Native
    // snapshots never poll the archive while the assistant streams; the timer only keeps
    // elapsed durations fresh.
    this.#refreshTimer = this.#manager.activitySnapshot
      ? setInterval(() => this.#repaint(), 1000)
      : setInterval(() => {
          if (this.#open() && UNFINISHED_STATES.has(this.#agent()?.run?.state))
            this.#onChange({ agentId: this.#agentId });
        }, 1000);
    this.#refreshTimer.unref?.();
    queueMicrotask(() => {
      if (this.#pendingMetadata || !this.#manager.activitySnapshot) this.#onChange({ agentId: this.#agentId });
    });
  }

  render(width) {
    const { tui, theme } = this.#page;
    // Capture established following before reflow; initial activity is
    // resolved only once, below, using the actual viewport dimensions.
    const tab = this.#tab;
    const atBottom = tab === 'activity' ? this.#followsActivity() : this.#following[tab] === true;
    this.#width = width;
    const agent = this.#agent();
    const rows = Math.max(1, tui.terminal?.rows ?? 40);
    if (!agent)
      return fullPageLines([], [truncateToWidth('Subagent unavailable', width)], [], tui.terminal?.rows ?? 40);
    const { header, footer } = detailChrome(agent, { tab, status: this.#status(), theme, width, rows });
    const body = this.#bodyRows();
    this.#bodyHeight = Math.max(1, rows - header.length - footer.length);
    if (tab === 'activity' && this.#following.activity === null) {
      this.#following.activity = UNFINISHED_STATES.has(agent.run?.state);
      if (this.#following.activity) {
        this.#scroll.activity = Math.max(0, body.length - this.#bodyHeight);
        if (this.#nextCursor !== undefined) this.#jumpEnd();
      }
    }
    const limit = Math.max(0, body.length - this.#bodyHeight);
    this.#scroll[tab] = atBottom ? limit : Math.min(this.#scroll[tab], limit);
    const row = text => truncateToWidth(` ${text}`, width);
    const visible = body.slice(this.#scroll[tab], this.#scroll[tab] + this.#bodyHeight).map(row);
    return fullPageLines(header, visible, footer, rows);
  }

  invalidate() {
    this.#response.invalidate();
    this.#activity.invalidate();
  }

  handleMouse(event) {
    if (!this.#open()) return;
    if (event.type === 'wheel' && event.wheelDelta) {
      this.#move(event.wheelDelta);
      return { handled: true, render: true };
    }
  }

  handleInput(data) {
    if (!this.#open()) return;
    const key = (id, fallback) => this.#page.keybindings?.matches?.(data, id) || matchesKey(data, fallback);
    const scroll = [
      { key: Key.pageDown, delta: this.#bodyHeight },
      { key: Key.pageUp, delta: -this.#bodyHeight },
      { key: Key.down, delta: 1 },
      { key: Key.up, delta: -1 },
    ].find(({ key: scrollKey }) => matchesKey(data, scrollKey));
    if (key('tui.select.cancel', Key.escape)) this.close();
    else if (['r', 'a', 'i'].includes(data) || matchesKey(data, Key.left) || matchesKey(data, Key.right))
      this.#selectTab(data);
    else if (key('app.tools.expand', Key.ctrl('o'))) {
      this.#activity.setExpanded(!this.#activity.expanded);
      this.#repaint();
    } else if (matchesKey(data, Key.end)) this.#jumpEnd();
    else if (matchesKey(data, Key.home)) this.#home();
    else if (scroll) this.#move(scroll.delta);
    else if (data === 's' && UNFINISHED_STATES.has(this.#agent()?.run?.state)) this.#stop();
  }

  #agent() {
    return this.#manager.findAgent(this.#agentId);
  }

  #open() {
    return !this.#closed && this.#alive();
  }

  #repaint() {
    if (this.#open()) this.#page.tui.requestRender();
  }

  #wrap(text) {
    return wrapRows(text, this.#width);
  }

  #activityRows() {
    return this.#activity.render(Math.max(1, this.#width - 2));
  }

  #status() {
    if (this.#error) return this.#error;
    if (this.#discarded || this.#activity.discarded) return 'Earlier content: reopen details.';
    return this.#paging ? 'Loading…' : '';
  }

  #bodyRows() {
    const agent = this.#agent();
    if (!agent) return ['Subagent unavailable'];
    if (this.#tab === 'information') return informationRows(agent, this.#page.theme, this.#width);
    if (this.#tab === 'activity') {
      const rows = this.#activityRows();
      return rows.length ? rows : ['No activity available.'];
    }
    if (this.#resultText) return this.#response.rows(this.#resultText, this.#page.theme, this.#width);
    return this.#wrap(
      UNFINISHED_STATES.has(agent.run?.state)
        ? 'Final response pending.'
        : (agent.run?.error ?? 'No final response available.'),
    );
  }

  /** Resets the response when the agent moved on to another run; returns whether it did. */
  #reconcileRun() {
    const runId = this.#agent()?.run?.runId;
    if (runId === this.#displayedRunId) return false;
    if (this.#manager.activitySnapshot) {
      // The new snapshot covers only its run. Retain finalized records from
      // preceding runs before retiring their buffered transient events.
      for (const event of this.#pendingActivity) {
        if (event.runId !== runId && event.data?.type === 'message_end') {
          this.#activity.runId = event.runId;
          this.#activity.event(event.data);
        }
      }
      this.#pendingActivity.length = 0;
    }
    this.#activity.message = undefined;
    this.#activity.tools.clear();
    this.#activity.snapshot(this.#manager.activitySnapshot?.(this.#agentId));
    this.#displayedRunId = runId;
    this.#resultText = '';
    this.#resultCursor = undefined;
    this.#resultNext = undefined;
    this.#resultLoadedRunId = undefined;
    this.#scroll.response = 0;
    this.#following.response = false;
    this.#error = '';
    return true;
  }

  /** Appends the next archive page to the activity transcript. */
  async #load() {
    try {
      const page = await this.#manager.transcript({
        agentId: this.#agentId,
        cursor: this.#cursor,
        maxBytes: PAGE_BYTES,
      });
      if (!this.#alive()) return;
      const removed = this.#activity.appendArchive(this.#reader.push(page.text));
      if (removed.length) {
        const prefix = new ActivityTranscript({ sdk: this.#sdk, cwd: this.#ctx.cwd });
        prefix.appendArchive(removed.map(record => record.message));
        this.#scroll.activity = Math.max(0, this.#scroll.activity - prefix.render(Math.max(1, this.#width - 2)).length);
        this.#discarded = true;
      }
      this.#nextCursor = page.nextCursor;
      this.#cursor = page.nextCursor ?? this.#cursor + Buffer.byteLength(page.text);
    } catch (cause) {
      this.#error = trim(cause.message, 300);
    }
  }

  /** Appends the next page of the displayed run's final response, once that run completed. */
  async #fetchResult() {
    const agent = this.#agent();
    if (agent?.run?.state !== 'completed') return;
    const runId = agent.run.runId;
    if (this.#resultLoadedRunId === runId && this.#resultCursor === undefined) return;
    const stillDisplayed = () => this.#alive() && this.#displayedRunId === runId && this.#agent()?.run?.runId === runId;
    try {
      const page = await this.#manager.result({
        agentId: this.#agentId,
        runId,
        cursor: this.#resultCursor,
        maxBytes: PAGE_BYTES,
      });
      if (!stillDisplayed()) return;
      this.#resultLoadedRunId = runId;
      this.#resultText += page.text ?? page.result ?? '';
      if (this.#resultText.length > MAX_RESULT_CHARS) {
        const removed = this.#resultText.slice(0, -MAX_RESULT_CHARS);
        this.#resultText = this.#resultText.slice(-MAX_RESULT_CHARS);
        this.#scroll.response = Math.max(0, this.#scroll.response - this.#wrap(removed).length);
        this.#discarded = true;
      }
      this.#resultNext = page.nextCursor;
      this.#resultCursor = page.nextCursor;
    } catch (cause) {
      if (stillDisplayed()) this.#error = trim(cause.message, 300);
    }
  }

  // Events may maintain following, never infer or enable it from geometry.
  #followsActivity() {
    return this.#following.activity === true && !this.#paging && this.#nextCursor === undefined;
  }

  #stickToActivityEnd() {
    this.#scroll.activity = Math.max(0, this.#activityRows().length - this.#bodyHeight);
  }

  #onChange(event) {
    if (!this.#open() || event.agentId !== this.#agentId) return;
    const atEnd = this.#followsActivity();
    const version = this.#scrollVersion;
    this.#reconcileRun();
    this.#loading = this.#loading.then(async () => {
      if (!this.#open()) return;
      // Snapshots/events carry active output. Metadata refreshes and the
      // terminal transition reconcile archive persistence, not every delta.
      const streaming = this.#manager.activitySnapshot && UNFINISHED_STATES.has(this.#agent()?.run?.state);
      if (this.#nextCursor === undefined && !streaming) await this.#load();
      if (this.#resultLoadedRunId !== this.#displayedRunId) await this.#fetchResult();
      if (atEnd && this.#followsActivity() && this.#scrollVersion === version && this.#tab === 'activity')
        this.#stickToActivityEnd();
      this.#repaint();
    });
    this.#repaint();
  }

  #onActivity(event) {
    if (!this.#open() || event.agentId !== this.#agentId || event.runId !== this.#displayedRunId) return;
    const atEnd = this.#followsActivity();
    this.#activity.event(event.data);
    if (atEnd && this.#tab === 'activity') this.#stickToActivityEnd();
    this.#repaint();
  }

  #hasMore(tab) {
    return tab === 'activity' ? this.#nextCursor !== undefined : tab === 'response' && this.#resultNext !== undefined;
  }

  /** Reads the next page of `tab` once; returns whether its cursor advanced. */
  async #readMore(tab) {
    if (tab === 'activity' && this.#nextCursor !== undefined) {
      const before = this.#cursor;
      await this.#load();
      return this.#cursor !== before;
    }
    if (tab === 'response' && this.#resultNext !== undefined) {
      const before = this.#resultCursor;
      await this.#fetchResult();
      return this.#resultCursor !== before;
    }
    return false;
  }

  #paged(task) {
    this.#paging = true;
    this.#loading = this.#loading.then(task).finally(() => {
      this.#paging = false;
      this.#repaint();
    });
  }

  #loadMore() {
    const tab = this.#tab;
    if (!this.#hasMore(tab) || this.#paging) return;
    this.#paged(async () => {
      if (this.#open()) await this.#readMore(tab);
    });
  }

  #move(delta) {
    const tab = this.#tab;
    const total = this.#bodyRows().length;
    this.#scroll[tab] = Math.max(0, Math.min(Math.max(0, total - this.#bodyHeight), this.#scroll[tab] + delta));
    this.#scrollVersion++;
    const atEnd = delta > 0 && this.#scroll[tab] + this.#bodyHeight >= total;
    this.#following[tab] = atEnd && !this.#hasMore(tab);
    if (atEnd) this.#loadMore();
    this.#repaint();
  }

  /** Scrolls `tab` to its end, reading every remaining page while the view stays on it. */
  #jumpEnd() {
    const tab = this.#tab;
    const version = ++this.#scrollVersion;
    const unchanged = () => this.#open() && this.#tab === tab && this.#scrollVersion === version;
    this.#following[tab] = true;
    this.#scroll[tab] = Math.max(0, this.#bodyRows().length - this.#bodyHeight);
    this.#paged(async () => {
      while (unchanged() && (await this.#readMore(tab)));
      if (unchanged()) this.#scroll[tab] = Math.max(0, this.#bodyRows().length - this.#bodyHeight);
    });
    this.#repaint();
  }

  #home() {
    this.#scroll[this.#tab] = 0;
    this.#following[this.#tab] = false;
    this.#scrollVersion++;
    this.#repaint();
  }

  #selectTab(data) {
    const step = matchesKey(data, Key.left) ? 2 : 1;
    this.#tab = { r: 'response', a: 'activity', i: 'information' }[data] ?? TABS[(TABS.indexOf(this.#tab) + step) % 3];
    this.#scrollVersion++;
    this.#repaint();
  }

  #stop() {
    try {
      this.#manager.assertCurrentBranch(this.#agentId);
    } catch (cause) {
      this.#error = trim(cause.message);
      this.#repaint();
      return;
    }
    void this.#manager.stop({ agentId: this.#agentId }).catch(cause => {
      this.#error = trim(cause.message);
      this.#repaint();
    });
    this.#repaint();
  }
}

/** Full-page detail of one agent: final response, activity log and run information tabs. */
export async function showAgentDetail({ ctx, manager, sdk, view, agentId }) {
  const detail = new AgentDetail({ ctx, manager, sdk, agentId, alive: view.alive });
  view.close = () => detail.detach();
  try {
    if (!(await detail.prepare())) return;
    await showFullPage(ctx, (tui, theme, keybindings, done) => {
      view.close = () => detail.close();
      detail.attach({ tui, theme, keybindings, done });
      return {
        render: width => detail.render(width),
        invalidate: () => detail.invalidate(),
        handleMouse: event => detail.handleMouse(event),
        handleInput: data => detail.handleInput(data),
      };
    });
  } finally {
    detail.detach();
    view.close = undefined;
  }
}
