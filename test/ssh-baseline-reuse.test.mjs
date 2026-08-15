import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { RouteManager } from '../src/network.js';
import { parseOpenSshConfig } from '../src/util.js';

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    child.emit('exit', 0);
  };
  return child;
}

const WINDOWS_SSH_G = `
user czm2025
hostname 172.23.207.70
port 22
remoteforward 35052 [127.0.0.1]:7890
`;

test('missing remote 35052 reuses successful SSH transport instead of opening a second baseline connection', async () => {
  let proxyProbes = 0;
  let baselineProbes = 0;
  let starts = 0;
  const child = fakeChild();
  const manager = new RouteManager({}, { mode: 'proxy' }, {
    resolve: async () => parseOpenSshConfig(WINDOWS_SSH_G, 'gdwyy70'),
    probeLocal: async () => ({ ok: true }),
    probeProxy: async (_alias, port) => {
      assert.equal(port, 35052);
      proxyProbes += 1;
      if (proxyProbes === 1) {
        // SSH reached the remote shell, but curl could not connect to 35052.
        return { ok: false, exitCode: 7, timedOut: false, stderr: '' };
      }
      return { ok: true, exitCode: 0, timedOut: false };
    },
    probeSsh: async () => { baselineProbes += 1; return { ok: true, exitCode: 0 }; },
    startConfiguredTunnel: () => { starts += 1; return child; },
    startExplicitTunnel: () => { throw new Error('fallback must not run'); },
    delay: async () => {},
  });

  const state = await manager.ensure('gdwyy70', { force: true });
  assert.equal(state.route, 'proxy');
  assert.equal(state.source, 'managed-config-forward');
  assert.equal(state.sshOk, true);
  assert.equal(starts, 1);
  assert.equal(baselineProbes, 0);
  await manager.stop();
});

test('banner failure gets a small backoff retry before declaring SSH unavailable', async () => {
  let baselineProbes = 0;
  let waits = 0;
  let starts = 0;
  const child = fakeChild();
  const manager = new RouteManager({}, { mode: 'proxy' }, {
    resolve: async () => parseOpenSshConfig(WINDOWS_SSH_G, 'gdwyy70'),
    probeLocal: async () => ({ ok: true }),
    probeProxy: async (_alias, port) => {
      assert.equal(port, 35052);
      if (starts === 0) {
        return {
          ok: false,
          exitCode: 255,
          timedOut: false,
          stderr: 'kex_exchange_identification: read: Unknown error',
        };
      }
      return { ok: true, exitCode: 0, timedOut: false };
    },
    probeSsh: async () => {
      baselineProbes += 1;
      if (baselineProbes === 1) {
        return { ok: false, exitCode: 255, stderr: 'banner exchange: Unknown error' };
      }
      return { ok: true, exitCode: 0, stderr: '' };
    },
    startConfiguredTunnel: () => { starts += 1; return child; },
    startExplicitTunnel: () => { throw new Error('fallback must not run'); },
    delay: async () => { waits += 1; },
  });

  const state = await manager.ensure('gdwyy70', { force: true });
  assert.equal(state.route, 'proxy');
  assert.equal(state.source, 'managed-config-forward');
  assert.equal(state.sshOk, true);
  assert.equal(baselineProbes, 2);
  assert.ok(waits >= 2);
  assert.equal(starts, 1);
  await manager.stop();
});
