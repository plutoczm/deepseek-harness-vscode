import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { probeLocalHttpProxy } from '../src/network.js';
import { normalizeConfig, parseSshUri, prefixShellEnvironment, proxyEnvironment } from '../src/util.js';

test('default configuration targets Windows mixed proxy 127.0.0.1:7890', () => {
  const config = normalizeConfig({});
  assert.equal(config.mode, 'auto');
  assert.equal(config.localProxyHost, '127.0.0.1');
  assert.equal(config.localProxyPort, 7890);
  assert.equal(config.remotePortStart, 17890);
});

test('ssh uri keeps alias, optional username, port and remote cwd', () => {
  assert.deepEqual(parseSshUri('ssh://czm2025@gdwyy70:2202/mnt/work'), {
    host: 'gdwyy70',
    username: 'czm2025',
    port: 2202,
    path: '/mnt/work',
    destination: 'czm2025@gdwyy70',
  });
});

test('proxy environment keeps DeepSeek API out of remote proxy', () => {
  const config = normalizeConfig({ noProxy: 'api.deepseek.com,.deepseek.com' });
  const env = proxyEnvironment(17890, config);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:17890');
  assert.match(env.NO_PROXY, /api\.deepseek\.com/u);
  assert.equal(env.NO_PROXY, env.no_proxy);
});

test('shell prefix quotes environment values', () => {
  const command = prefixShellEnvironment('git status', { HTTPS_PROXY: 'http://127.0.0.1:17890' });
  assert.match(command, /^export HTTPS_PROXY=/u);
  assert.match(command, /git status$/u);
});

test('local HTTP CONNECT proxy probe recognizes a 200 response', async () => {
  const server = net.createServer((socket) => {
    socket.once('data', () => socket.end('HTTP/1.1 200 Connection established\r\n\r\n'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const result = await probeLocalHttpProxy('127.0.0.1', address.port, 1000);
  server.close();
  assert.equal(result.ok, true);
});
