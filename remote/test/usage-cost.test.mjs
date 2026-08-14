import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulateUsage,
  cacheHitPercent,
  priceForModel,
  usageCostCny,
} from '../src/usage-cost.mjs';

test('prices DeepSeek V4 Flash token buckets in CNY', () => {
  assert.equal(usageCostCny('deepseek-v4-flash', {
    uncachedInputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    outputTokens: 1_000_000,
  }, { at: '2026-08-14T12:00:00+08:00' }), 3.02);
});

test('prices DeepSeek V4 Pro token buckets in CNY', () => {
  assert.equal(usageCostCny('deepseek-v4-pro', {
    uncachedInputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    outputTokens: 1_000_000,
  }, { at: '2026-08-14T12:00:00+08:00' }), 9.025);
});

test('cache hit percentage matches Harness billed-input semantics', () => {
  assert.equal(cacheHitPercent({
    uncachedInputTokens: 300,
    cacheReadTokens: 700,
    cacheWriteTokens: 0,
    outputTokens: 20,
  }), 70);
});

test('time-of-use schedule selects the price at request start in Beijing time', () => {
  const schedules = [{
    id: 'synthetic-peak-rule',
    effectiveFrom: '2026-08-17T00:00:00+08:00',
    effectiveTo: null,
    timeZone: 'Asia/Shanghai',
    models: {
      'deepseek-v4-flash': { cacheHit: 0.02, cacheMiss: 1, output: 2 },
    },
    windows: [
      { id: 'morning-peak', start: '09:00', end: '12:00', multiplier: 2 },
      { id: 'afternoon-peak', start: '14:00', end: '18:00', multiplier: 2 },
    ],
  }];

  const before = priceForModel('deepseek-v4-flash', {
    at: '2026-08-17T08:59:59+08:00', schedules,
  });
  const morning = priceForModel('deepseek-v4-flash', {
    at: '2026-08-17T09:00:00+08:00', schedules,
  });
  const noon = priceForModel('deepseek-v4-flash', {
    at: '2026-08-17T12:00:00+08:00', schedules,
  });
  const afternoon = priceForModel('deepseek-v4-flash', {
    at: '2026-08-17T14:00:00+08:00', schedules,
  });

  assert.equal(before.output, 2);
  assert.equal(before.timeWindow, null);
  assert.equal(morning.output, 4);
  assert.equal(morning.timeWindow, 'morning-peak');
  assert.equal(noon.output, 2);
  assert.equal(afternoon.output, 4);
  assert.equal(afternoon.timeWindow, 'afternoon-peak');
});

test('accumulates usage immediately per session and preserves request start time', () => {
  const first = accumulateUsage(undefined, {
    sessionId: 'session-1',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    usage: {
      inputTokens: 800,
      cacheReadTokens: 200,
      outputTokens: 100,
    },
    startedAt: '2026-08-14T11:59:58.000+08:00',
    at: '2026-08-14T12:00:00.000+08:00',
  });
  const second = accumulateUsage(first, {
    sessionId: 'session-1',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    usage: {
      inputTokens: 500,
      cacheReadTokens: 500,
      outputTokens: 200,
    },
    startedAt: '2026-08-14T12:00:00.500+08:00',
    at: '2026-08-14T12:00:01.000+08:00',
  });

  assert.equal(second.requests, 2);
  assert.equal(second.inputTokens, 2_000);
  assert.equal(second.outputTokens, 300);
  assert.equal(second.cacheHitPercent, 35);
  assert.equal(second.last.inputTokens, 1_000);
  assert.equal(second.last.cacheHitPercent, 50);
  assert.equal(second.last.startedAt, '2026-08-14T12:00:00.500+08:00');
  assert.ok(second.costCny > first.costCny);
  assert.equal(second.updatedAt, '2026-08-14T12:00:01.000+08:00');
});

test('keeps exact token telemetry when model pricing is unknown', () => {
  const state = accumulateUsage(undefined, {
    sessionId: 'session-2',
    provider: 'custom',
    model: 'private-model',
    usage: { inputTokens: 123, outputTokens: 45 },
  });
  assert.equal(state.inputTokens, 123);
  assert.equal(state.outputTokens, 45);
  assert.equal(state.costCny, 0);
  assert.equal(state.pricingKnown, false);
  assert.equal(state.unpricedRequests, 1);
  assert.equal(usageCostCny('private-model', state.totals), null);
});
