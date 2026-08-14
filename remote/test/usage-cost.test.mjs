import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulateUsage,
  cacheHitPercent,
  usageCostCny,
} from '../src/usage-cost.mjs';

test('prices DeepSeek V4 Flash token buckets in CNY', () => {
  assert.equal(usageCostCny('deepseek-v4-flash', {
    uncachedInputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    outputTokens: 1_000_000,
  }), 3.02);
});

test('prices DeepSeek V4 Pro token buckets in CNY', () => {
  assert.equal(usageCostCny('deepseek-v4-pro', {
    uncachedInputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    outputTokens: 1_000_000,
  }), 9.025);
});

test('cache hit percentage matches Harness billed-input semantics', () => {
  assert.equal(cacheHitPercent({
    uncachedInputTokens: 300,
    cacheReadTokens: 700,
    cacheWriteTokens: 0,
    outputTokens: 20,
  }), 70);
});

test('accumulates usage immediately per session', () => {
  const first = accumulateUsage(undefined, {
    sessionId: 'session-1',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    usage: {
      inputTokens: 800,
      cacheReadTokens: 200,
      outputTokens: 100,
    },
    at: '2026-08-14T12:00:00.000Z',
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
    at: '2026-08-14T12:00:01.000Z',
  });

  assert.equal(second.requests, 2);
  assert.equal(second.inputTokens, 2_000);
  assert.equal(second.outputTokens, 300);
  assert.equal(second.cacheHitPercent, 35);
  assert.equal(second.last.inputTokens, 1_000);
  assert.equal(second.last.cacheHitPercent, 50);
  assert.ok(second.costCny > first.costCny);
  assert.equal(second.updatedAt, '2026-08-14T12:00:01.000Z');
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
