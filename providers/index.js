/**
 * Provider registry.
 *
 * Adding a provider means writing one module with the shape below and listing
 * it here — nothing above this layer knows a vendor name:
 *
 *   { id, label, keyEnv, keyUrl, keyHint, models, transcribeModels,
 *     defaults, supports, stream(), complete(), transcribe() }
 */

'use strict';

const gemini = require('./gemini');
const openai = require('./openai');
const anthropic = require('./anthropic');
const shared = require('./shared');

const PROVIDERS = [gemini, openai, anthropic];
const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

const DEFAULT_PROVIDER = gemini.id;

function listProviders() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    keyEnv: p.keyEnv,
    keyUrl: p.keyUrl,
    keyHint: p.keyHint,
    blurb: p.blurb,
    models: p.models,
    transcribeModels: p.transcribeModels,
    defaults: p.defaults,
    supports: p.supports
  }));
}

/** Never throws: an unknown id (a stale setting, a hand-edited file) falls back. */
function getProvider(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_PROVIDER);
}

function hasProvider(id) {
  return BY_ID.has(id);
}

/**
 * Settles a provider/model pair against what actually exists. A model the user
 * typed by hand is kept as-is — new model ids ship faster than this catalogue
 * updates, and refusing them would age badly.
 */
function resolveModel(providerId, model) {
  const provider = getProvider(providerId);
  const known = provider.models.some((m) => m.id === model);
  return {
    providerId: provider.id,
    model: model && (known || typeof model === 'string') ? model : provider.defaults.model
  };
}

/** The cheapest, quickest model a provider offers — for suggestions and synthesis. */
function fastModel(providerId) {
  const provider = getProvider(providerId);
  return (provider.models.find((m) => m.fast) || provider.models[0]).id;
}

function supportsVision(providerId, model) {
  const provider = getProvider(providerId);
  const entry = provider.models.find((m) => m.id === model);
  return entry ? entry.vision !== false : provider.supports.vision;
}

module.exports = {
  PROVIDERS, DEFAULT_PROVIDER,
  listProviders, getProvider, hasProvider, resolveModel, fastModel, supportsVision,
  ProviderError: shared.ProviderError,
  NO_API_KEY: shared.NO_API_KEY,
  trimImages: shared.trimImages,
  textOf: shared.textOf,
  hasImage: shared.hasImage
};
