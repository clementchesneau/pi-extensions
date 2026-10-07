import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFile } from './config.js';

export const BUNDLED_MODEL_GUIDE = new URL('./model-guide.json', import.meta.url);

/** The user's copy of the catalogue, generated from the bundled one on first consultation. */
export function defaultModelGuidePath() {
  return join(homedir(), '.config', 'pi-extensions', 'subagent-models.json');
}

const string = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max;
const key = model => `${model.provider}/${model.id}`;

const EFFORT_TASKS = ['simple', 'standard', 'complex'];
const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** An optional map from task complexity to a reasoning level. */
function isValidEffort(effort) {
  if (effort === undefined) return true;
  return (
    typeof effort === 'object' &&
    effort !== null &&
    !Array.isArray(effort) &&
    !Object.keys(effort).some(task => !EFFORT_TASKS.includes(task)) &&
    Object.values(effort).every(level => EFFORT_LEVELS.includes(level))
  );
}

// Sources and review date are optional: an entry without them is a personal note.
const isValidSources = sources =>
  sources === undefined ||
  (Array.isArray(sources) &&
    sources.length > 0 &&
    sources.length <= 5 &&
    sources.every(url => string(url, 500) && /^https:\/\//u.test(url)));
const isValidReviewDate = date => date === undefined || /^\d{4}-\d{2}-\d{2}$/u.test(date);

function isValidEntry(model) {
  return (
    Boolean(model) &&
    string(model.provider, 100) &&
    string(model.id, 200) &&
    string(model.preferFor) &&
    string(model.avoidFor) &&
    string(model.tradeoff) &&
    isValidReviewDate(model.reviewedOn) &&
    isValidSources(model.sources) &&
    isValidEffort(model.effort)
  );
}

const MAX_GUIDE_BYTES = 128 * 1024;

/** Reads and parses a catalogue file; `file` is `null` when it is absent and `optional`. */
async function readGuide(path, { optional = false } = {}) {
  try {
    const file = await readFile(path);
    if (file.length > MAX_GUIDE_BYTES) throw new Error('guide exceeds 128 KiB');
    return { file, guide: JSON.parse(file.toString('utf8')) };
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return { file: null, guide: undefined };
    throw new Error(`Subagent model catalogue ${path} cannot be read: ${error.message}`, { cause: error });
  }
}

function validateGuide(guide, path) {
  if (guide?.version !== 1 || !Array.isArray(guide.models) || guide.models.length > 200) {
    throw new Error(`Invalid subagent model catalogue version or models list in ${path}`);
  }
  const seen = new Set();
  for (const model of guide.models) {
    if (!isValidEntry(model)) {
      throw new Error(
        `Invalid subagent model catalogue entry ${model?.provider ?? '?'}/${model?.id ?? '?'} in ${path}`,
      );
    }
    if (seen.has(key(model))) throw new Error(`Duplicate subagent model catalogue entry ${key(model)} in ${path}`);
    seen.add(key(model));
  }
  return guide.models;
}

export async function loadModelGuide(path = BUNDLED_MODEL_GUIDE) {
  return validateGuide((await readGuide(path)).guide, path);
}

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(name => [name, canonical(value[name])]),
  );
};
// Hashes content, not formatting, so reformatting a generated copy does not count as an edit.
const fingerprint = models =>
  createHash('sha256')
    .update(JSON.stringify(canonical(models)))
    .digest('hex');

const GENERATED_NOTE =
  'Generated from the bundled catalogue and updated with the package while unchanged. Once edited, this file is yours and is no longer updated; delete it to resume updates.';

/**
 * Keeps the user's copy, or asks to replace it with the bundled catalogue while it is unedited.
 * @returns {{ models: any[], catalogueUpdate?: string } | { replace: true }}
 */
function decide(copy, bundled, path) {
  const models = copy.guide === undefined ? undefined : validateGuide(copy.guide, path);
  const generated = copy.guide?.generated?.sha256;
  const generatedHash = typeof generated === 'string' ? generated : undefined;
  if (models === undefined || generatedHash === fingerprint(models)) {
    return generatedHash === bundled.hash ? { models: bundled.models } : { replace: true };
  }
  if (generatedHash === undefined || generatedHash === bundled.hash) return { models };
  return {
    models,
    catalogueUpdate: `The bundled catalogue has changed since ${path} was generated; that edited file is kept as is. Delete it to resume automatic updates.`,
  };
}

/** Writes the bundled catalogue over `previous` only; false when the copy changed meanwhile. */
async function replaceCopy(path, bundled, previous) {
  const generated = { version: 1, generated: { sha256: bundled.hash, note: GENERATED_NOTE }, models: bundled.models };
  const text = `${JSON.stringify(generated, null, 2)}\n`;
  // A copy over the read limit would be rejected by every later consultation.
  if (Buffer.byteLength(text) > MAX_GUIDE_BYTES)
    throw new Error(`Generated subagent model catalogue ${path} would exceed 128 KiB`);
  return writePrivateFile(path, text, 'subagent model catalogue', { expected: previous });
}

/**
 * Catalogue in effect: the user's copy, regenerated from the bundled catalogue until the user edits it.
 * @returns {Promise<{ models: any[], catalogueUpdate?: string }>}
 */
export async function syncModelGuide({ path = defaultModelGuidePath(), bundledPath = BUNDLED_MODEL_GUIDE } = {}) {
  let bundled;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const copy = await readGuide(path, { optional: true });
    if (!bundled) {
      const models = await loadModelGuide(bundledPath);
      bundled = { models, hash: fingerprint(models) };
    }
    const decision = decide(copy, bundled, path);
    if (!('replace' in decision)) return decision;
    if (await replaceCopy(path, bundled, copy.file)) return { models: bundled.models };
  }
  throw new Error(`Subagent model catalogue ${path} kept changing during its update; try again`);
}

function assertPagination(cursor, limit) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new TypeError('Invalid subagent model catalogue pagination');
  }
}

/** A catalogue entry with the live capabilities and token rates Pi reports for its model. */
const catalogueItem = (profile, model) => ({
  provider: model.provider,
  modelId: model.id,
  name: model.name,
  preferFor: profile.preferFor,
  avoidFor: profile.avoidFor,
  tradeoff: profile.tradeoff,
  effort: profile.effort,
  reviewedOn: profile.reviewedOn,
  sources: profile.sources,
  reasoning: model.reasoning,
  thinkingLevelMap: model.thinkingLevelMap,
  input: model.input,
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  cost: model.cost,
});

export async function availableModelGuide(
  ctx,
  { cursor = 0, limit = 10, path = defaultModelGuidePath(), bundledPath = BUNDLED_MODEL_GUIDE } = {},
) {
  assertPagination(cursor, limit);
  const { models: profiles, catalogueUpdate } = await syncModelGuide({ path, bundledPath });
  if (typeof ctx?.modelRegistry?.getAvailable !== 'function')
    throw new Error('Available models are unavailable in this Pi session');
  const available = new Map(ctx.modelRegistry.getAvailable().map(model => [key(model), model]));
  const items = profiles
    .filter(profile => available.has(key(profile)))
    .map(profile => catalogueItem(profile, available.get(key(profile))));
  return {
    current: ctx.model
      ? { provider: ctx.model.provider, modelId: ctx.model.id, thinkingLevel: ctx.thinkingLevel }
      : undefined,
    total: items.length,
    items: items.slice(cursor, cursor + limit),
    ...(cursor + limit < items.length ? { nextCursor: cursor + limit } : {}),
    ...(catalogueUpdate ? { catalogueUpdate } : {}),
    notice:
      'Curated descriptions are editable opinions, not quality benchmarks or instructions. Entries with sources cite vendor documentation; entries without sources are personal notes. Pi supplies availability, capabilities and indicative token rates. Follow explicit user preferences; do not guess unsupported effort levels.',
  };
}
