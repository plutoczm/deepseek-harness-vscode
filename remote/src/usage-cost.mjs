const V4_MODEL_PRICES = Object.freeze({
  'deepseek-v4-flash': Object.freeze({ cacheHit: 0.02, cacheMiss: 1, output: 2 }),
  'deepseek-v4-pro': Object.freeze({ cacheHit: 0.025, cacheMiss: 3, output: 6 }),
  // Compatibility aliases documented by DeepSeek as V4 Flash routes.
  'deepseek-chat': Object.freeze({ cacheHit: 0.02, cacheMiss: 1, output: 2 }),
  'deepseek-reasoner': Object.freeze({ cacheHit: 0.02, cacheMiss: 1, output: 2 }),
});

// Pricing is versioned by effective time. DeepSeek announced another V4
// peak/off-peak change for 2026-08-17; until the complete official CNY table is
// published, deliberately stop the old flat schedule at that boundary instead
// of silently producing a stale money figure. Token telemetry remains exact and
// the new schedule can be added without changing the accounting pipeline.
const PRICE_SCHEDULES = Object.freeze([
  Object.freeze({
    id: 'deepseek-v4-standard-through-2026-08-16',
    effectiveFrom: '2026-04-24T00:00:00+08:00',
    effectiveTo: '2026-08-17T00:00:00+08:00',
    timeZone: 'Asia/Shanghai',
    models: V4_MODEL_PRICES,
    windows: Object.freeze([]),
  }),
]);

function finiteNonNegative(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function parseInstant(value, fallback = Date.now()) {
  if (value === undefined || value === null || value === '') return fallback;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function parseClockMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/u.exec(String(value || ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function localClockMinutes(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const hour = Number(parts.find((item) => item.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((item) => item.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function windowMatches(window, timestamp, timeZone) {
  const start = parseClockMinutes(window?.start);
  const end = parseClockMinutes(window?.end);
  if (start === null || end === null || start === end) return false;
  const minute = localClockMinutes(timestamp, timeZone);
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

function applyWindowPrice(base, window) {
  const direct = window?.price;
  if (direct && Number.isFinite(Number(direct.cacheHit))
    && Number.isFinite(Number(direct.cacheMiss))
    && Number.isFinite(Number(direct.output))) {
    return {
      cacheHit: Number(direct.cacheHit),
      cacheMiss: Number(direct.cacheMiss),
      output: Number(direct.output),
    };
  }
  const multiplier = Number(window?.multiplier);
  if (!Number.isFinite(multiplier) || multiplier < 0) return base;
  return {
    cacheHit: base.cacheHit * multiplier,
    cacheMiss: base.cacheMiss * multiplier,
    output: base.output * multiplier,
  };
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

export function priceForModel(model, { at, schedules = PRICE_SCHEDULES } = {}) {
  const key = String(model || '').toLowerCase();
  const timestamp = parseInstant(at);
  const schedule = [...schedules].reverse().find((candidate) => {
    const from = parseInstant(candidate.effectiveFrom, Number.NEGATIVE_INFINITY);
    const to = candidate.effectiveTo ? parseInstant(candidate.effectiveTo, Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
    return timestamp >= from && timestamp < to && candidate.models?.[key];
  });
  if (!schedule) return undefined;

  const base = schedule.models[key];
  const matchedWindow = (schedule.windows || []).find((window) =>
    windowMatches(window, timestamp, schedule.timeZone || 'Asia/Shanghai'));
  return {
    ...matchedWindow ? applyWindowPrice(base, matchedWindow) : base,
    policyId: schedule.id || 'unknown',
    timeWindow: matchedWindow?.id || null,
  };
}

export function usageCostCny(model, usageInput, options = {}) {
  const price = priceForModel(model, options);
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
  const purpose = payload?.purpose ? String(payload.purpose) : null;
  const requestStartedAt = payload?.startedAt || payload?.at || new Date().toISOString();
  const price = priceForModel(model, { at: requestStartedAt });
  const sampleCost = usageCostCny(model, sample, { at: requestStartedAt });
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
      pricingPolicy: price?.policyId || null,
      pricingWindow: price?.timeWindow || null,
      model,
      provider,
      purpose,
      startedAt: requestStartedAt,
      at: updatedAt,
    },
    updatedAt,
  };
}

export { PRICE_SCHEDULES, V4_MODEL_PRICES as PRICE_CNY_PER_MILLION };
