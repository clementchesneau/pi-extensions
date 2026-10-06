import { truncateToWidth } from '@earendil-works/pi-tui';
import { formatFooter, summarizeUsage } from './format.js';
import { createGitCoordinator } from './git.js';

function footerLines(ctx, { width, theme, footerData, gitSnapshot, compactionState }) {
  const usage = summarizeUsage(ctx.sessionManager.getBranch());
  const context = ctx.getContextUsage();
  const lines = formatFooter({
    width,
    cwd: ctx.cwd,
    provider: ctx.model?.provider,
    model: ctx.model?.id,
    thinking: ctx.thinkingLevel,
    branch: gitSnapshot?.state === 'unknown' ? 'git ?' : gitSnapshot?.branch,
    changedFiles: gitSnapshot?.changedFiles,
    contextPercent: context?.percent,
    contextWindow: ctx.model?.contextWindow,
    compactionState,
    ...usage,
    style: (token, text) => theme.fg(token, text),
  });
  const statuses = [...footerData.getExtensionStatuses().entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [, status] of statuses) {
    for (const line of String(status).split('\n')) {
      lines.push(truncateToWidth(line, Math.max(0, width), ''));
    }
  }
  return lines;
}

function cancelGit(state) {
  state.coordinator?.cancel();
  state.coordinator = undefined;
  state.gitSnapshot = undefined;
}

/** Footer component of installation `installed`; disposing it uninstalls only that installation. */
function footerComponent(ctx, state, { installed, git, refreshGit }) {
  return (tui, theme, footerData) => {
    const render = () => tui.requestRender();
    state.requestRender = render;
    const unsubscribe = footerData.onBranchChange(() => {
      void refreshGit(ctx);
    });
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        if (installed === state.generation) {
          state.active = false;
          state.generation += 1;
          git.cancel();
          if (state.coordinator === git) state.coordinator = undefined;
          state.gitSnapshot = undefined;
        }
        if (state.requestRender === render) state.requestRender = undefined;
      },
      invalidate() {},
      render: width =>
        footerLines(ctx, {
          width,
          theme,
          footerData,
          gitSnapshot: state.gitSnapshot,
          compactionState: state.compactionState,
        }),
    };
  };
}

/**
 * Graphite footer: model, context, usage, local Git state and extension statuses. Each
 * installation has a generation; a replaced footer or a stale Git read changes nothing.
 */
export function createFooter(pi, { gitReader, isEnabled }) {
  const state = {
    active: false,
    generation: 0,
    requestRender: undefined,
    coordinator: undefined,
    gitSnapshot: undefined,
    compactionState: undefined,
  };
  pi.events?.on('session-compaction:state', compactionState => {
    state.compactionState = compactionState;
    if (state.active) state.requestRender?.();
  });

  const isActive = ctx => state.active && ctx.mode === 'tui';
  const refreshGit = ctx =>
    !isEnabled() || !isActive(ctx) || !state.coordinator ? Promise.resolve() : state.coordinator.refresh();

  return {
    isActive,
    refreshGit,
    render: () => state.requestRender?.(),

    install(ctx) {
      cancelGit(state);
      state.active = true;
      const installed = ++state.generation;
      const git = createGitCoordinator({
        cwd: ctx.cwd,
        reader: gitReader,
        onSnapshot(snapshot) {
          if (!isActive(ctx) || !isEnabled() || installed !== state.generation) return;
          state.gitSnapshot = snapshot;
          state.requestRender?.();
        },
      });
      state.coordinator = git;
      ctx.ui.setFooter(footerComponent(ctx, state, { installed, git, refreshGit }));
      pi.events?.emit('session-compaction:request-state');
      void refreshGit(ctx);
    },

    /** Stops Git reads; returns whether this footer was still installed. */
    uninstall() {
      const installed = state.active;
      state.active = false;
      state.generation += 1;
      cancelGit(state);
      state.requestRender = undefined;
      return installed;
    },

    /** A new session has not installed its footer yet. */
    reset() {
      state.active = false;
    },

    clearCompactionState() {
      state.compactionState = undefined;
    },

    gitError() {
      return state.gitSnapshot?.state === 'unknown' ? state.gitSnapshot.error : undefined;
    },
  };
}
