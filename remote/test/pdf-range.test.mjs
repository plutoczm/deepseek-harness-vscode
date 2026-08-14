import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHttpByteRange } from '../src/files.mjs';

test('returns the complete PDF when no Range header is supplied', () => {
  assert.deepEqual(parseHttpByteRange(undefined, 1000), {
    start: 0,
    end: 999,
    length: 1000,
    partial: false,
  });
});

test('parses bounded and open-ended HTTP byte ranges', () => {
  assert.deepEqual(parseHttpByteRange('bytes=100-199', 1000), {
    start: 100,
    end: 199,
    length: 100,
    partial: true,
  });
  assert.deepEqual(parseHttpByteRange('bytes=900-', 1000), {
    start: 900,
    end: 999,
    length: 100,
    partial: true,
  });
  assert.deepEqual(parseHttpByteRange('bytes=900-5000', 1000), {
    start: 900,
    end: 999,
    length: 100,
    partial: true,
  });
});

test('parses suffix ranges used by PDF readers', () => {
  assert.deepEqual(parseHttpByteRange('bytes=-128', 1000), {
    start: 872,
    end: 999,
    length: 128,
    partial: true,
  });
});

test('rejects invalid or unsatisfiable ranges', () => {
  assert.equal(parseHttpByteRange('bytes=1000-', 1000), null);
  assert.equal(parseHttpByteRange('bytes=500-100', 1000), null);
  assert.equal(parseHttpByteRange('bytes=0-1,5-7', 1000), null);
  assert.equal(parseHttpByteRange('items=0-10', 1000), null);
});
