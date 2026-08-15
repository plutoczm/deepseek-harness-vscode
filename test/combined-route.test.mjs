import assert from 'node:assert/strict';
import test from 'node:test';
import { RouteManager } from '../src/network.js';
import { parseOpenSshConfig } from '../src/util.js';

const WINDOWS_SSH_G = `
user czm2025
hostname 172.23.207.70
port 22
identityfile ~/.ssh/id_rsa
remoteforward 35052 [127.0.0.1]:7890
`;

test('initial proxy status can resolve SSH baseline and existing RemoteForward in one remote probe', async () => {
  let routeProbes = 0;
  const manager = new RouteManager({}, { mode: 'proxy' }, {
    resolve: async () => parseOpenSshConfig(WINDOWS_SSH_G, 'gdwyy70'),
    probeRoute: async (_alias, options) => {
      routeProbes += 1;
      assert.equal(options.includeDirect, false);
      assert.equal(options.proxyPort, 35052);
      return {
        ok: true,
        sshOk: true,
        directOk: false,
        proxyOk: true,
        exitCode: 0,
        stdout: 'DSH_PROXY=1\nDSH_SSH=1\n',
        stderr: '',
      };
    },
    probeLocal: async () => ({ ok: true, detail: 'HTTP/1.1 200 Connection established' }),
    probeDirect: async () => { throw new Error('legacy direct probe must not run'); },
    probeProxy: async () => { throw new Error('legacy proxy probe must not run for initial status'); },
    probeSsh: async () => { throw new Error('separate baseline probe must not run'); },
    delay: async () => {},
  });

  const state = await manager.ensure('gdwyy70', { force: true });
  assert.equal(routeProbes, 1);
  assert.equal(state.sshOk, true);
  assert.equal(state.route, 'proxy');
  assert.equal(state.source, 'existing-config-forward');
  assert.equal(state.remotePort, 35052);
  await manager.stop();
});

test('combined AUTO probe chooses direct without a second SSH handshake', async () => {
  let routeProbes = 0;
  const manager = new RouteManager({}, { mode: 'auto' }, {
    resolve: async () => parseOpenSshConfig(WINDOWS_SSH_G, 'gdwyy70'),
    probeRoute: async (_alias, options) => {
      routeProbes += 1;
      assert.equal(options.includeDirect, true);
      assert.equal(options.proxyPort, 35052);
      return {
        ok: true,
        sshOk: true,
        directOk: true,
        proxyOk: false,
        exitCode: 0,
        stdout: 'DSH_DIRECT=1\nDSH_PROXY=0\nDSH_SSH=1\n',
        stderr: '',
      };
    },
    probeLocal: async () => ({ ok: true }),
    delay: async () => {},
  });

  const state = await manager.ensure('gdwyy70', { force: true });
  assert.equal(routeProbes, 1);
  assert.equal(state.route, 'direct');
  assert.equal(state.source, 'remote-direct');
  assert.equal(state.sshOk, true);
  await manager.stop();
});
