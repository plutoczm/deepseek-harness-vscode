import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { RouteManager } from '../src/network.js';
import { parseOpenSshConfig } from '../src/util.js';

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
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

test('health refresh never mistakes its own managed 35052 for an external forward', async () => {
  let probes = 0;
  let starts = 0;
  const child = fakeChild();
  const manager = new RouteManager({}, { mode: 'proxy' }, {
    resolve: async () => parseOpenSshConfig(WINDOWS_SSH_G, 'gdwyy70'),
    probeLocal: async () => ({ ok: true }),
    probeSsh: async () => ({ ok: true }),
    probeProxy: async (_alias, port) => {
      assert.equal(port, 35052);
      probes += 1;
      return { ok: probes >= 2 };
    },
    startConfiguredTunnel: () => { starts += 1; return child; },
    startExplicitTunnel: () => { throw new Error('fallback must not run'); },
    delay: async () => {},
  });

  const first = await manager.ensure('gdwyy70', { force: true });
  assert.equal(first.route, 'proxy');
  assert.equal(first.source, 'managed-config-forward');
  assert.equal(first.remotePort, 35052);
  assert.equal(starts, 1);
  assert.equal(child.exitCode, null);

  const refreshed = await manager.ensure('gdwyy70', { force: true });
  assert.equal(refreshed.route, 'proxy');
  assert.equal(refreshed.source, 'managed-config-forward');
  assert.equal(refreshed.remotePort, 35052);
  assert.equal(starts, 1);
  assert.equal(child.exitCode, null);
  assert.equal(manager.snapshot('gdwyy70')[0].managedTunnelAlive, true);
  assert.equal(manager.snapshot('gdwyy70')[0].managedTunnelPid, 4242);

  await manager.stop();
});

test('unexpected managed tunnel exit invalidates the cached proxy route immediately', async () => {
  let starts = 0;
  let currentChild;
  const children = [fakeChild(5001), fakeChild(5002)];
  const manager = new RouteManager({}, { mode: 'proxy' }, {
    resolve: async () => parseOpenSshConfig(WINDOWS_SSH_G, 'gdwyy70'),
    probeLocal: async () => ({ ok: true }),
    probeSsh: async () => ({ ok: true }),
    probeProxy: async (_alias, port) => {
      assert.equal(port, 35052);
      return { ok: Boolean(currentChild && currentChild.exitCode === null) };
    },
    startConfiguredTunnel: () => {
      currentChild = children[starts++];
      return currentChild;
    },
    startExplicitTunnel: () => { throw new Error('fallback must not run'); },
    delay: async () => {},
  });

  const first = await manager.ensure('gdwyy70', { force: true });
  assert.equal(first.source, 'managed-config-forward');
  assert.equal(starts, 1);

  children[0].exitCode = 255;
  children[0].emit('exit', 255);
  const exited = manager.snapshot('gdwyy70')[0];
  assert.equal(exited.route, 'unavailable');
  assert.equal(exited.source, 'managed-tunnel-exited');
  assert.equal(exited.remotePort, undefined);
  assert.equal(exited.managedTunnelAlive, false);

  // ensure() must not reuse the stale 15-second cache after a managed exit.
  const rebuilt = await manager.ensure('gdwyy70');
  assert.equal(rebuilt.route, 'proxy');
  assert.equal(rebuilt.source, 'managed-config-forward');
  assert.equal(starts, 2);
  assert.equal(manager.snapshot('gdwyy70')[0].managedTunnelPid, 5002);

  await manager.stop();
});
