import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeNetworkMode } from '../src/network.mjs';

test('network mode defaults to automatic direct-first policy', () => {
  assert.equal(normalizeNetworkMode(undefined), 'auto');
  assert.equal(normalizeNetworkMode(''), 'auto');
  assert.equal(normalizeNetworkMode('unexpected'), 'auto');
});

test('network mode accepts explicit policies', () => {
  assert.equal(normalizeNetworkMode('auto'), 'auto');
  assert.equal(normalizeNetworkMode('DIRECT'), 'direct');
  assert.equal(normalizeNetworkMode(' local-proxy '), 'local-proxy');
});

test('legacy local-proxy flag remains backward compatible', () => {
  assert.equal(normalizeNetworkMode(undefined, true), 'local-proxy');
  assert.equal(normalizeNetworkMode('direct', true), 'direct');
});
