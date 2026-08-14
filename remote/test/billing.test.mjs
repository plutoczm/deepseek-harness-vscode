import assert from 'node:assert/strict';
import test from 'node:test';
import { balanceDelta } from '../src/billing.mjs';

test('balanceDelta reports account balance decrease per currency', () => {
  const baseline = {
    available: true,
    balances: [
      { currency: 'CNY', total: 100 },
      { currency: 'USD', total: 10 },
    ],
  };
  const current = {
    available: true,
    balances: [
      { currency: 'CNY', total: 98.75 },
      { currency: 'USD', total: 9.5 },
    ],
  };
  assert.deepEqual(balanceDelta(baseline, current), [
    { currency: 'CNY', amount: 1.25 },
    { currency: 'USD', amount: 0.5 },
  ]);
});

test('balanceDelta never reports a negative spend after a top-up', () => {
  const baseline = { available: true, balances: [{ currency: 'CNY', total: 10 }] };
  const current = { available: true, balances: [{ currency: 'CNY', total: 20 }] };
  assert.deepEqual(balanceDelta(baseline, current), [{ currency: 'CNY', amount: 0 }]);
});
