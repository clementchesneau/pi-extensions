const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const NAME = /^[\w.-]+$/;
const MAX_COMMENTS = 100;
const NOT_FOUND = Symbol('not found');
// First path segments GitHub reserves for its own pages, so they never name an account.
const RESERVED = new Set(
  'about account apps codespaces collections contact copilot dashboard discussions enterprise events explore features issues join login logout marketplace new notifications organizations orgs pricing pulls search security sessions settings signup site sponsors stars team topics trending users watching'.split(
    ' ',
  ),
);

/**
 * @typedef {{ owner: string, name: string }} Repository
 * @typedef {Repository & (
 *   | { type: 'repository' }
 *   | { type: 'directory', ref: string, path: string }
 *   | { type: 'file', rawUrl: string }
 *   | { type: 'issue' | 'pull-request', number: string }
 * )} GitHubTarget
 */

/**
 * @param {Repository} repo
 * @param {string | undefined} kind
 * @param {string[]} rest
 * @returns {GitHubTarget | undefined}
 */
function repositoryTarget(repo, kind, rest) {
  if (kind === undefined) return { type: 'repository', ...repo };
  if (kind === 'tree' && rest.length)
    return { type: 'directory', ...repo, ref: rest[0], path: rest.slice(1).join('/') };
  if (kind === 'blob' && rest.length > 1) {
    return { type: 'file', ...repo, rawUrl: `${RAW}/${repo.owner}/${repo.name}/${rest.join('/')}` };
  }
  if ((kind === 'issues' || kind === 'pull') && /^\d+$/.test(rest[0] ?? '')) {
    return { type: kind === 'pull' ? 'pull-request' : 'issue', ...repo, number: rest[0] };
  }
  return undefined;
}

/**
 * What a github.com URL designates when GitHub's public API or raw files read it better than the
 * HTML page: a repository, directory, file, issue or pull request. Other pages return undefined.
 * @param {string} input
 */
export function githubTarget(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (!['github.com', 'www.github.com'].includes(url.hostname)) return undefined;
  const [owner, name, kind, ...rest] = url.pathname.split('/').filter(Boolean);
  if (!owner || !name || RESERVED.has(owner.toLowerCase()) || !NAME.test(owner) || !NAME.test(name)) return undefined;
  return repositoryTarget({ owner, name: name.replace(/\.git$/, '') }, kind, rest);
}

function rateLimitError(headers = {}) {
  const reset = Number(headers['x-ratelimit-reset']);
  const retryAfter = Number(headers['retry-after']);
  let when = '';
  if (retryAfter > 0) when = `; retry after ${retryAfter} seconds`;
  else if (reset > 0) when = `; resets at ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC`;
  return new Error(
    `GitHub API rate limit reached (60 requests per hour without authentication${when}). Use the GitHub CLI (gh) through the shell if it is available, or retry later.`,
  );
}

function apiError(response, target) {
  const headers = response.headers ?? {};
  const limited = headers['x-ratelimit-remaining'] === '0' || headers['retry-after'] !== undefined;
  if (response.status === 429 || (response.status === 403 && limited)) return rateLimitError(headers);
  if (response.status === 404) {
    const branch = target.type === 'directory' ? " Branch names containing '/' are not supported in tree URLs." : '';
    return new Error(
      `GitHub API request failed (HTTP 404): this repository, path, issue or pull request does not exist or is private.${branch} For a private repository, use the GitHub CLI (gh) through the shell if it is available.`,
    );
  }
  return new Error(`GitHub API request failed (HTTP ${response.status}).`);
}

async function apiGet(path, target, { signal, request, budget, optional = false }) {
  const response = await request(`${API}${path}`, {
    signal,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    maxBytes: budget.remaining,
  });
  budget.remaining -= response.bytes?.length ?? Buffer.byteLength(response.body ?? '');
  if (optional && response.status === 404) return NOT_FOUND;
  if (response.status !== 200) throw apiError(response, target);
  try {
    return JSON.parse(response.body);
  } catch (error) {
    throw new Error('GitHub API returned an unreadable response.', { cause: error });
  }
}

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function listing(entries, blobBase) {
  if (!Array.isArray(entries)) throw new Error('This GitHub URL does not designate a directory.');
  const lines = entries.map(entry => {
    const path = entry.path ?? entry.name;
    if (entry.type === 'dir') return `- ${path}/`;
    if (entry.type === 'file') return `- ${path} (${size(entry.size)})`;
    return `- ${path} (${entry.type})`;
  });
  return `## Files\n\n${lines.join('\n') || 'Empty directory.'}\n\nRead a file at ${blobBase}/<path>, or clone the repository with git through the shell to explore it in depth.`;
}

async function repositoryPage(target, options) {
  const { owner, name } = target;
  // A 404 may be a GitHub page with a two-segment path, such as /advisories/<id>: the caller then
  // reads the ordinary page, which also reports a missing or private repository.
  const entries = await apiGet(`/repos/${owner}/${name}/contents/`, target, { ...options, optional: true });
  if (entries === NOT_FOUND) return undefined;
  const readme = await apiGet(`/repos/${owner}/${name}/readme`, target, { ...options, optional: true });
  const readmeText =
    readme !== NOT_FOUND && readme?.content
      ? Buffer.from(readme.content, 'base64').toString('utf8').trim()
      : 'No README found.';
  return {
    url: `https://github.com/${owner}/${name}`,
    title: `${owner}/${name}`,
    extraction: 'github-repository',
    markdown: `${listing(entries, `https://github.com/${owner}/${name}/blob/HEAD`)}\n\n## README\n\n${readmeText}`,
  };
}

function decodedRef(ref) {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

async function directoryPage(target, options) {
  const { owner, name, ref, path } = target;
  const entries = await apiGet(
    `/repos/${owner}/${name}/contents/${path}?ref=${encodeURIComponent(decodedRef(ref))}`,
    target,
    options,
  );
  return {
    url: `https://github.com/${owner}/${name}/tree/${ref}${path ? `/${path}` : ''}`,
    title: `${owner}/${name}${path ? `/${path}` : ''} @ ${ref}`,
    extraction: 'github-directory',
    markdown: listing(entries, `https://github.com/${owner}/${name}/blob/${ref}`),
  };
}

function commentsMarkdown(comments, total) {
  const sections = comments.map(comment =>
    `### @${comment.user?.login ?? 'unknown'} · ${String(comment.created_at).slice(0, 10)}\n\n${comment.body ?? ''}`.trim(),
  );
  const more = total > comments.length ? `\n\n[Showing the first ${comments.length} of ${total} comments.]` : '';
  return `## Comments (${total})\n\n${sections.join('\n\n')}${more}`;
}

async function discussionPage(target, options) {
  const { owner, name, number } = target;
  const issue = await apiGet(`/repos/${owner}/${name}/issues/${number}`, target, options);
  const isPull = Boolean(issue.pull_request);
  const comments = issue.comments
    ? await apiGet(`/repos/${owner}/${name}/issues/${number}/comments?per_page=${MAX_COMMENTS}`, target, options)
    : [];
  const state = issue.pull_request?.merged_at ? 'merged' : issue.state;
  const header = [
    `# ${issue.title} (#${issue.number})`,
    `${isPull ? 'Pull request' : 'Issue'} · ${state} · opened by @${issue.user?.login ?? 'unknown'} on ${String(issue.created_at).slice(0, 10)}`,
    ...(issue.labels?.length ? [`Labels: ${issue.labels.map(label => label.name).join(', ')}`] : []),
    ...(isPull ? [`Diff: ${issue.html_url}.diff`] : []),
  ].join('\n');
  const parts = [header, issue.body?.trim() || 'No description.'];
  if (isPull) parts.push('Inline review comments are not included.');
  if (issue.comments) parts.push(commentsMarkdown(comments, issue.comments));
  return {
    url: issue.html_url,
    title: `${issue.title} · ${owner}/${name}#${issue.number}`,
    extraction: isPull ? 'github-pull-request' : 'github-issue',
    markdown: parts.join('\n\n'),
  };
}

/**
 * Reads a repository, directory, issue or pull request through GitHub's public API, without a token.
 * Undefined when a repository path turns out not to be one, so the caller reads the ordinary page.
 * @param {Exclude<GitHubTarget, { type: 'file' }>} target
 * @param {{ signal?: AbortSignal, request: Function, budget: { remaining: number } }} options
 *   `signal` and `budget` are shared by every request behind the URL, so together they keep its
 *   time and size limits.
 */
export function fetchGitHub(target, options) {
  if (target.type === 'repository') return repositoryPage(target, options);
  if (target.type === 'directory') return directoryPage(target, options);
  return discussionPage(target, options);
}
