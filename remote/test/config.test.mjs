import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  isSupportedRemoteNode,
  parseNodeVersion,
  parseSshConfig,
} from '../src/config.mjs';

test('parseSshConfig returns concrete aliases and ignores wildcard hosts', () => {
  const input = `
Host GDWYY70 gpu-a
  HostName 10.0.0.1
Host *
  ServerAliveInterval 20
Host !blocked gpu-?
Host lab-server # comment
`;
  assert.deepEqual(parseSshConfig(input), ['GDWYY70', 'gpu-a', 'lab-server']);
});

test('node version gate requires at least 22.19.0', () => {
  assert.deepEqual(parseNodeVersion('v22.19.0'), [22, 19, 0]);
  assert.equal(isSupportedRemoteNode('v20.18.0'), false);
  assert.equal(isSupportedRemoteNode('v22.18.9'), false);
  assert.equal(isSupportedRemoteNode('v22.19.0'), true);
  assert.equal(isSupportedRemoteNode('v24.0.0'), true);
  assert.equal(compareVersions([22, 19, 0], [22, 19, 0]), 0);
});
