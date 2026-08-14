const PRICE_CNY_PER_MILLION = Object.freeze({
  'deepseek-v4-flash': Object.freeze({ cacheHit: 0.02, cacheMiss: 1, output: 2 }),
  'deepseek-v4-pro': Object.freeze({ cacheHit: 0.025, cacheMiss: 3, output: 6 }),
  // Historical aliases mapped to V4 Flash for compatibility with old sessions.
  'deepseek-chat': Object.freeze({ cacheHit: 0.02, cacheMiss: 1, output: 2 }),
  'deepseek-reasoner': Object.freeze({ cacheHit: 0.02, cacheMiss: 1, output: 2 }),
});

function finiteNonNegative(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function normalizeTokenUsage(raw = {}) {
  return {
    uncachedInputTokens: finiteNonNegative(raw.inputTokens),
    cacheReadTokens: finiteNonNegative(raw.cacheReadTokens),
    cacheWriteTokens: finiteNonNegative(raw.cacheWriteTokens),
    outputTokens: finiteNonNegative(raw.outputTokens),
    reasoningTokens: finiteNonNegative(raw.reasoningTokens),
  };
}

export function billedInputTokens(usage) {
  return finiteNonNegative(usage?.uncachedInputTokens)
    + finiteNonNegative(usage?.cacheReadTokens)
    + finiteNonNegative(usage?.cacheWriteTokens);
}

export function cacheHitPercent(usage) {
  const input = billedInputTokens(usage);
  if (input <= 0) return null;
  return finiteNonNegative(usage?.cacheReadTokens) / input * 100;
}

export function priceForModel(model) {
  return PRICE_CNY_PER_MILLION[String(model || '').toLowerCase()];
}

export function usageCostCny(model, usageInput) {
  const price = priceForModel(model);
  if (!price) return null;
  const usage = normalizeTokenUsage({
    inputTokens: usageInput?.uncachedInputTokens ?? usageInput?.inputTokens,
    cacheReadTokens: usageInput?.cacheReadTokens,
    cacheWriteTokens: usageInput?.cacheWriteTokens,
    outputTokens: usageInput?.outputTokens,
    reasoningTokens: usageInput?.reasoningTokens,
  });
  // DeepSeek does not currently report cache writes separately. If a future
  // adapter does, treat writes as uncached input because they require prompt
  // processing rather than a cache read.
  const missTokens = usage.uncachedInputTokens + usage.cacheWriteTokens;
  return (
    missTokens * price.cacheMiss
    + usage.cacheReadTokens * price.cacheHit
    + usage.outputTokens * price.output
  ) / 1_000_000;
}

function emptyTotals() {
  return {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

function addTotals(left, right) {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

export function accumulateUsage(previous, payload) {
  const sample = normalizeTokenUsage(payload?.usage);
  const model = String(payload?.model || previous?.model || '');
  const provider = String(payload?.provider || previous?.provider || '');
  const sessionId = String(payload?.sessionId || previous?.sessionId || '');
  const sampleCost = usageCostCny(model, sample);
  const totals = addTotals(previous?.totals ?? emptyTotals(), sample);
  const knownCost = Number(previous?.costCny || 0) + (sampleCost ?? 0);
  const pricedRequests = Number(previous?.pricedRequests || 0) + (sampleCost === null ? 0 : 1);
  const unpricedRequests = Number(previous?.unpricedRequests || 0) + (sampleCost === null ? 1 : 0);
  const updatedAt = payload?.at || new Date().toISOString();

  return {
    sessionId,
    provider,
    model,
    requests: Number(previous?.requests || 0) + 1,
    pricedRequests,
    unpricedRequests,
    totals,
    inputTokens: billedInputTokens(totals),
    outputTokens: totals.outputTokens,
    cacheHitPercent: cacheHitPercent(totals),
    costCny: knownCost,
    pricingKnown: unpricedRequests === 0,
    last: {
      ...sample,
      inputTokens: billedInputTokens(sample),
      cacheHitPercent: cacheHitPercent(sample),
      costCny: sampleCost,
      pricingKnown: sampleCost !== null,
      model,
      provider,
      at: updatedAt,
    },
    updatedAt,
  };
}

export { PRICE_CNY_PER_MILLION };
