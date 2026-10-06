import { Context7, Context7Error } from '@upstash/context7-sdk';
import { readContext7ApiKey } from './config.js';

export const CONTEXT7_TIMEOUT_MS = 20_000;
const MAX_INPUT_LENGTH = 500;
const UNEXPECTED_RESPONSE = 'Context7 returned an unexpected response.';

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Context7 ${name} must be a non-empty string.`);
  }
  if (value.length > MAX_INPUT_LENGTH) {
    throw new Error(`Context7 ${name} must not exceed ${MAX_INPUT_LENGTH} characters.`);
  }
  return value;
}

function libraryId(value) {
  const id = requiredText(value, 'libraryId');
  if (!/^\/[^/\s]+\/[^/\s]+(?:\/[^\s]+)?$/.test(id)) {
    throw new Error('Context7 libraryId must be an identifier returned by context7_resolve.');
  }
  return id;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeLibraries(value) {
  if (!Array.isArray(value)) throw new Error(UNEXPECTED_RESPONSE);
  return value.map(candidate => {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof candidate.id !== 'string' ||
      typeof candidate.name !== 'string' ||
      typeof candidate.description !== 'string' ||
      !isFiniteNumber(candidate.totalSnippets) ||
      !isFiniteNumber(candidate.trustScore) ||
      !isFiniteNumber(candidate.benchmarkScore) ||
      (candidate.versions !== undefined &&
        (!Array.isArray(candidate.versions) || candidate.versions.some(version => typeof version !== 'string')))
    ) {
      throw new Error(UNEXPECTED_RESPONSE);
    }
    return {
      id: candidate.id,
      name: candidate.name,
      description: candidate.description,
      totalSnippets: candidate.totalSnippets,
      trustScore: candidate.trustScore,
      benchmarkScore: candidate.benchmarkScore,
      ...(candidate.versions === undefined ? {} : { versions: [...candidate.versions] }),
    };
  });
}

function normalizeDocs(value) {
  if (!Array.isArray(value)) throw new Error(UNEXPECTED_RESPONSE);
  return value.map(snippet => {
    if (
      !snippet ||
      typeof snippet !== 'object' ||
      typeof snippet.title !== 'string' ||
      typeof snippet.content !== 'string' ||
      typeof snippet.source !== 'string'
    ) {
      throw new Error(UNEXPECTED_RESPONSE);
    }
    return { title: snippet.title, content: snippet.content, source: snippet.source };
  });
}

/** Message-safe replacement for a known Context7 failure, if it is one. */
function knownContext7Failure(error) {
  if (error.code === 'invalid_json_response' || error.code === 'invalid_response') {
    return new Error(UNEXPECTED_RESPONSE);
  }
  if (error.status === 401 || error.status === 403 || error.code === 'authentication_error') {
    return new Error('Context7 authentication was refused. Check CONTEXT7_API_KEY.');
  }
  if (error.status === 429) return new Error('Context7 quota or rate limit was reached.');
  if (error.code === 'request_timeout') return new Error('Context7 request timed out.');
  if (error.code === 'network_error') return new Error('Context7 network transport failed.');
  return undefined;
}

function safeError(error) {
  if (error?.name === 'AbortError' || (error instanceof Context7Error && error.code === 'request_aborted')) {
    return new DOMException('Context7 request was cancelled.', 'AbortError');
  }
  const known = error instanceof Context7Error ? knownContext7Failure(error) : undefined;
  if (known) return known;
  if (error instanceof Error && (error.message === UNEXPECTED_RESPONSE || error instanceof TypeError)) {
    return new Error(UNEXPECTED_RESPONSE);
  }
  return new Error('Context7 request failed.');
}

async function clientFor(options) {
  const apiKey = await (options.readKey ?? readContext7ApiKey)({
    env: options.env,
    filePath: options.configPath,
  });
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error('CONTEXT7_API_KEY is not configured.');
  }
  const transport = options.fetch ?? globalThis.fetch?.bind(globalThis);
  const config = {
    apiKey,
    retry: false,
    timeout: options.timeout ?? CONTEXT7_TIMEOUT_MS,
    signal: options.signal,
    ...(transport
      ? {
          // Native fetch follows redirects by default, which would violate the
          // one-request-per-tool-call quota boundary.
          fetch: (input, init) => transport(input, { ...init, redirect: 'manual' }),
        }
      : {}),
  };
  return (options.clientFactory ?? (value => new Context7(value)))(config);
}

export async function resolveContext7Library({ libraryName, query }, options = {}) {
  const validLibraryName = requiredText(libraryName, 'libraryName');
  const validQuery = requiredText(query, 'query');
  options.signal?.throwIfAborted();
  const client = await clientFor(options);
  options.signal?.throwIfAborted();
  try {
    const candidates = normalizeLibraries(
      await client.searchLibrary(validQuery, validLibraryName, {
        type: 'json',
        signal: options.signal,
        timeout: options.timeout ?? CONTEXT7_TIMEOUT_MS,
      }),
    );
    return { provider: 'Context7', candidates };
  } catch (error) {
    throw safeError(error);
  }
}

export async function getContext7Docs({ libraryId: requestedId, query }, options = {}) {
  const validLibraryId = libraryId(requestedId);
  const validQuery = requiredText(query, 'query');
  options.signal?.throwIfAborted();
  const client = await clientFor(options);
  options.signal?.throwIfAborted();
  try {
    const snippets = normalizeDocs(
      await client.getContext(validQuery, validLibraryId, {
        type: 'json',
        signal: options.signal,
        timeout: options.timeout ?? CONTEXT7_TIMEOUT_MS,
      }),
    );
    return { provider: 'Context7', libraryId: validLibraryId, snippets };
  } catch (error) {
    throw safeError(error);
  }
}
