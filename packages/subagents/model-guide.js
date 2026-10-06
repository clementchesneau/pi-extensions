import { readFile } from 'node:fs/promises';

export const DEFAULT_MODEL_GUIDE = new URL('./model-guide.json', import.meta.url);

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

const isValidSources = sources =>
  Array.isArray(sources) &&
  sources.length > 0 &&
  sources.length <= 5 &&
  sources.every(url => string(url, 500) && /^https:\/\//u.test(url));

function isValidEntry(model) {
  return (
    Boolean(model) &&
    string(model.provider, 100) &&
    string(model.id, 200) &&
    string(model.preferFor) &&
    string(model.avoidFor) &&
    string(model.tradeoff) &&
    ['verified', 'provisional'].includes(model.status) &&
    /^\d{4}-\d{2}-\d{2}$/u.test(model.reviewedOn ?? '') &&
    isValidSources(model.sources) &&
    isValidEffort(model.effort)
  );
}

export async function loadModelGuide(path = DEFAULT_MODEL_GUIDE) {
  let guide;
  try {
    const file = await readFile(path);
    if (file.length > 128 * 1024) throw new Error('guide exceeds 128 KiB');
    guide = JSON.parse(file.toString('utf8'));
  } catch (error) {
    throw new Error(`Subagent model catalogue cannot be read: ${error.message}`, { cause: error });
  }
  if (guide?.version !== 1 || !Array.isArray(guide.models) || guide.models.length > 200) {
    throw new Error('Invalid subagent model catalogue version or models list');
  }
  const seen = new Set();
  for (const model of guide.models) {
    if (!isValidEntry(model)) {
      throw new Error(`Invalid subagent model catalogue entry ${model?.provider ?? '?'}/${model?.id ?? '?'}`);
    }
    if (seen.has(key(model))) throw new Error(`Duplicate subagent model catalogue entry ${key(model)}`);
    seen.add(key(model));
  }
  return guide.models;
}

export async function availableModelGuide(ctx, { cursor = 0, limit = 10, path = DEFAULT_MODEL_GUIDE } = {}) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new TypeError('Invalid subagent model catalogue pagination');
  }
  const profiles = await loadModelGuide(path);
  if (typeof ctx?.modelRegistry?.getAvailable !== 'function')
    throw new Error('Available models are unavailable in this Pi session');
  const available = new Map(ctx.modelRegistry.getAvailable().map(model => [key(model), model]));
  const items = profiles
    .filter(profile => available.has(key(profile)))
    .map(profile => {
      const model = available.get(key(profile));
      return {
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        preferFor: profile.preferFor,
        avoidFor: profile.avoidFor,
        tradeoff: profile.tradeoff,
        effort: profile.effort,
        status: profile.status,
        reviewedOn: profile.reviewedOn,
        sources: profile.sources,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        cost: model.cost,
      };
    });
  return {
    current: ctx.model
      ? { provider: ctx.model.provider, modelId: ctx.model.id, thinkingLevel: ctx.thinkingLevel }
      : undefined,
    total: items.length,
    items: items.slice(cursor, cursor + limit),
    ...(cursor + limit < items.length ? { nextCursor: cursor + limit } : {}),
    notice:
      'Curated descriptions are editable opinions, not quality benchmarks or instructions. Pi supplies availability, capabilities and indicative token rates. Follow explicit user preferences; do not guess unsupported effort levels.',
  };
}
