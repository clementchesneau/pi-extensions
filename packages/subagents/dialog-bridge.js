const DIALOG_METHODS = ['confirm', 'select', 'input', 'editor'];
const IGNORED_METHODS = ['setTitle', 'set_editor_text', 'setWidget', 'setStatus'];

function openDialog(ui, title, request, timeout) {
  if (request.method === 'confirm') return ui.confirm(title, request.message ?? '', { timeout });
  if (request.method === 'select') return ui.select(title, request.options ?? [], { timeout });
  if (request.method === 'input') return ui.input(title, request.placeholder, { timeout });
  return ui.editor(title, request.prefill);
}

function dialogResponse(request, value) {
  if (request.method === 'confirm') return { id: request.id, confirmed: value === true };
  if (value === undefined) return { id: request.id, cancelled: true };
  return { id: request.id, value };
}

/**
 * Relays a child's UI requests to the parent session. Dialogs open one at a time, each
 * bounded by a timeout, and `abort()` cancels the pending and future ones. Requests the
 * parent cannot show are answered as cancelled so the child never waits forever.
 */
export function createDialogBridge({ ctx, notify, timeoutMs }) {
  let tail = Promise.resolve();
  const aborted = new AbortController();

  const bounded = (dialog, timeout) => {
    let timer;
    let cancel;
    const stopped = new Promise((_, reject) => {
      cancel = () => reject(new Error('Subagent dialog was cancelled'));
      if (aborted.signal.aborted) cancel();
      else aborted.signal.addEventListener('abort', cancel, { once: true });
    });
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Subagent dialog timed out')), timeout);
    });
    return Promise.race([dialog, stopped, deadline]).finally(() => {
      clearTimeout(timer);
      aborted.signal.removeEventListener('abort', cancel);
    });
  };

  // The RPC editor contract used here has neither a timeout nor a cancellation signal.
  // Do not open a parent dialog that can outlive the child request.
  const canShow = request =>
    DIALOG_METHODS.includes(request.method) && ctx.hasUI && !(ctx.mode === 'rpc' && request.method === 'editor');

  return {
    abort: () => aborted.abort(),

    async handleUiRequest(agent, request, childRuntime) {
      if (request.method === 'notify') {
        notify(ctx, `[${agent.alias}] ${request.message ?? ''}`, request.notifyType);
        return;
      }
      if (IGNORED_METHODS.includes(request.method)) return;
      if (!canShow(request)) {
        await childRuntime.respondUi({ id: request.id, cancelled: true });
        return;
      }
      const title = `[${agent.alias}] ${request.title ?? 'Subagent request'}`;
      const dialog = tail.then(() => {
        if (aborted.signal.aborted) throw new Error('Subagent dialog was cancelled');
        const requested = Number.isSafeInteger(request.timeout) && request.timeout > 0 ? request.timeout : timeoutMs;
        const timeout = Math.min(timeoutMs, requested);
        return bounded(openDialog(ctx.ui, title, request, timeout), timeout);
      });
      tail = dialog.catch(() => {});
      try {
        await childRuntime.respondUi(dialogResponse(request, await dialog));
      } catch {
        await childRuntime.respondUi({ id: request.id, cancelled: true }).catch(() => {});
      }
    },
  };
}
