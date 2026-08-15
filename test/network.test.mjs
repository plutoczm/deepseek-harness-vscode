import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { RouteManager, probeLocalHttpProxy } from '../src/network.js';
import {
  buildConfiguredTunnelArgs,
  buildExplicitTunnelArgs,
  buildSshExecArgs,
} from '../src/openssh.js';
import {
  matchingProxyForward,
  normalizeConfig,
  parseConcreteHostAliases,
  parseOpenSshConfig,
  prefixShellEnvironment,
  proxyEnvironment,
} from '../src/util.js';

function fakeChild({ exitCode = null } = {}) {
  const child = new EventEmitter();
  child.exitCode = exitCode;
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
identityfile ~/.ssh/id_rsa
identityfile ~/.ssh/id_ed25519
remoteforward 35052 [127.0.0.1]:7890
`;

test('default configuration targets Windows mixed proxy 127.0.0.1:7890', () => {
  const config = normalizeConfig({});
  assert.equal(config.mode, 'auto');
  assert.equal(config.localProxyHost, '127.0.0.1');
  assert.equal(config.localProxyPort, 7890);
  assert.equal(config.remotePortStart, 17890);
});

test('parses the real Windows ssh -G RemoteForward shape', () => {
  const resolved = parseOpenSshConfig(WINDOWS_SSH_G, 'gdwyy70');
  assert.equal(resolved.alias, 'gdwyy70');
  assert.equal(resolved.hostname, '172.23.207.70');
  assert.equal(resolved.user, 'czm2025');
  assert.equal(resolved.port, 22);
  assert.deepEqual(resolved.identityFiles, ['~/.ssh/id_rsa', '~/.ssh/id_ed25519']);
  assert.deepEqual(resolved.remoteForwards, [{
    listenHost: '127.0.0.1',
    listenPort: 35052,
    targetHost: '127.0.0.1',
    targetPort: 7890,
    raw: '35052 [127.0.0.1]:7890',
  }]);

  const match = matchingProxyForward(resolved, normalizeConfig({}));
  assert.equal(match.listenPort, 35052);
});

test('concrete Host parser ignores wildcard config blocks', () => {
  const aliases = parseConcreteHostAliases(`
Host *
  ServerAliveInterval 20
Host gdwyy70 gpu02
  User czm2025
Host !blocked *.internal
  User nobody
`);
  assert.deepEqual(aliases.sort(), ['gdwyy70', 'gpu02']);
});

test('ordinary OpenSSH operations clear configured forwards', () => {
  const args = buildSshExecArgs('gdwyy70');
  assert.ok(args.includes('ClearAllForwardings=yes'));
  assert.equal(args.at(-1), 'gdwyy70');
});

test('managed tunnel owners fail loud on forwarding errors', () => {
  const configured = buildConfiguredTunnelArgs('gdwyy70');
  assert.ok(!configured.includes('ClearAllForwardings=yes'));
  assert.ok(configured.includes('ExitOnForwardFailure=yes'));
  assert.ok(configured.includes('-N'));

  const explicit = buildExplicitTunnelArgs('gdwyy70', 17890, '127.0.0.1', 7890);
  assert.ok(!explicit.includes('ClearAllForwardings=yes'));
  assert.ok(explicit.includes('ExitOnForwardFailure=yes'));
  assert.ok(explicit.includes('-R'));
  assert.ok(explicit.includes('127.0.0.1:17890:127.0.0.1:7890'));
});

test('proxy environment keeps DeepSeek API out of remote proxy', () => {
  const config = normalizeConfig({ noProxy: 'api.deepseek.com,.deepseek.com' });
  const env = proxyEnvironment(35052, config);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:35052');
  assert.match(env.NO_PROXY, /api\.deepseek\.com/u);
  assert.equal(env.NO_PROXY, env.no_proxy);
});

test('shell prefix quotes environment values', () => {
  const command = prefixShellEnvironment('git status', { HTTPS_PROXY: 'http://127.0.0.1:35052' });
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

test('route manager reuses an existing VS Code RemoteForward without spawning a tunnel', async () => {
  let spawned = 0;
  let baselineProbes = 0;
  const manager = new RouteManager({}, { mode: 'proxy' }, {
    resolve: async () => parseOpenSshConfig(WINDOWS_SSH_G, 'gdwyy70'),
    probeDirect: async () => ({ ok: false }),
    probeLocal: async () => ({ ok: true }),
    probeSsh: async () => { baselineProbes += 1; return { ok: true }; },
    probeProxy: async (_alias, port) => ({ ok: port === 35052 }),
    startConfiguredTunnel: () => { spawned += 1; return fakeChild(); },
    startExplicitTunnel: () => { spawned += 1; return fakeChild(); },
    delay: async () => {},
  });

  const state = await manager.ensure('gdwyy70', { force: true });
  assert.equal(state.route, 'proxy');
  assert.equal(state.source, 'existing-config-forward');
  assert.equal(state.remotePort, 35052);
  assert.equal(spawned, 0);
  assert.equal(baselineProbes, 0);
  assert.equal(manager.proxyEnv('gdwyy70').HTTPS_PROXY, 'http://127.0.0.1:35052');
  await manager.stop();
});

test('SSH banner/reset failure prevents all managed tunnel spawning', async () => {
  let configuredStarts = 0;
  let explicitStarts = 0;
  const manager = new RouteManager({}, { mode: 'proxy' }, {
    resolve: async () => parseOpenSshConfig(WINDOWS_SSH_G, 'gdwyy70'),
    probeLocal: async () => ({ ok: true }),
    probeProxy: async () => ({ ok: false }),
    probeSsh: async () => ({
      ok: false,
      stderr: 'kex_exchange_identification: read: Connection reset\nConnection reset by 172.23.207.70 port 22',
    }),
    startConfiguredTunnel: () => { configuredStarts += 1; return fakeChild(); },
    startExplicitTunnel: () => { explicitStarts += 1; return fakeChild(); },
  });

  const state = await manager.ensure('gdwyy70', { force: true });
  assert.equal(state.route, 'unavailable');
  assert.equal(state.source, 'ssh-unavailable');
  assert.equal(state.sshOk, false);
  assert.match(state.error, /Connection reset by 172\.23\.207\.70/u);
  assert.equal(configuredStarts, 0);
  assert.equal(explicitStarts, 0);
  await manager.stop();
});

test('route manager owns the configured forward only when the external 35052 tunnel is absent', async () => {
  let probes = 0;
  let configuredStarts = 0;
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
    startConfiguredTunnel: () => { configuredStarts += 1; return child; },
    startExplicitTunnel: () => { throw new Error('explicit fallback should not be needed'); },
    delay: async () => {},
  });

  const state = await manager.ensure('gdwyy70', { force: true });
  assert.equal(configuredStarts, 1);
  assert.equal(state.route, 'proxy');
  assert.equal(state.source, 'managed-config-forward');
  assert.equal(state.remotePort, 35052);
  await manager.stop();
  assert.equal(child.exitCode, 0);
});

test('managed configured forward waits for a real OpenSSH handshake instead of failing after 650ms', async () => {
  let probes = 0;
  let waits = 0;
  const child = fakeChild();
  const manager = new RouteManager({}, { mode: 'proxy', probeTimeoutMs: 8000 }, {
    resolve: async () => parseOpenSshConfig(WINDOWS_SSH_G, 'gdwyy70'),
    probeLocal: async () => ({ ok: true, detail: 'HTTP/1.1 200 Connection established' }),
    probeSsh: async () => ({ ok: true }),
    probeProxy: async (_alias, port) => {
      assert.equal(port, 35052);
      probes += 1;
      // First probe checks for an external VS Code tunnel. The next three
      // model a Windows OpenSSH process that is still handshaking. Only the
      // fifth probe sees the configured RemoteForward become usable.
      return { ok: probes >= 5 };
    },
    startConfiguredTunnel: () => child,
    startExplicitTunnel: () => { throw new Error('fallback must not run while configured tunnel is still starting'); },
    delay: async () => { waits += 1; },
  });

  const state = await manager.ensure('gdwyy70', { force: true });
  assert.equal(state.route, 'proxy');
  assert.equal(state.source, 'managed-config-forward');
  assert.equal(state.remotePort, 35052);
  assert.equal(probes, 5);
  assert.ok(waits >= 3);
  await manager.stop();
});

test('configured forward bind race reuses the winner instead of opening 17890', async () => {
  let probes = 0;
  let explicitStarts = 0;
  const failedChild = fakeChild({ exitCode: 255 });
  const manager = new RouteManager({}, { mode: 'proxy' }, {
    resolve: async () => parseOpenSshConfig(WINDOWS_SSH_G, 'gdwyy70'),
    probeLocal: async () => ({ ok: true }),
    probeSsh: async () => ({ ok: true }),
    probeProxy: async (_alias, port) => {
      assert.equal(port, 35052);
      probes += 1;
      // Initial external probe fails; configured child loses the race and
      // exits; the post-race re-probe sees the other process's live 35052.
      return { ok: probes >= 2 };
    },
    startConfiguredTunnel: () => failedChild,
    startExplicitTunnel: () => { explicitStarts += 1; return fakeChild(); },
    delay: async () => {},
  });

  const state = await manager.ensure('gdwyy70', { force: true });
  assert.equal(state.route, 'proxy');
  assert.equal(state.source, 'existing-config-forward');
  assert.equal(state.remotePort, 35052);
  assert.equal(explicitStarts, 0);
  await manager.stop();
});

test('matching configured RemoteForward failure never silently switches to 17890', async () => {
  let explicitStarts = 0;
  const failedChild = fakeChild({ exitCode: 255 });
  const manager = new RouteManager({}, { mode: 'proxy' }, {
    resolve: async () => parseOpenSshConfig(WINDOWS_SSH_G, 'gdwyy70'),
    probeLocal: async () => ({ ok: true }),
    probeSsh: async () => ({ ok: true }),
    probeProxy: async () => ({ ok: false }),
    startConfiguredTunnel: () => failedChild,
    startExplicitTunnel: () => { explicitStarts += 1; return fakeChild(); },
    delay: async () => {},
  });

  const state = await manager.ensure('gdwyy70', { force: true });
  assert.equal(state.route, 'unavailable');
  assert.equal(state.source, 'configured-forward-unavailable');
  assert.equal(explicitStarts, 0);
  assert.match(state.error, /Configured RemoteForward 35052 failed/u);
  await manager.stop();
});

test('route manager falls back to an independent 17890+ reverse tunnel when no matching RemoteForward exists', async () => {
  const resolved = parseOpenSshConfig('user czm2025\nhostname 172.23.207.70\nport 22\n', 'gdwyy70');
  let explicitPort;
  const manager = new RouteManager({}, { mode: 'proxy', remotePortStart: 17890 }, {
    resolve: async () => resolved,
    probeLocal: async () => ({ ok: true }),
    probeSsh: async () => ({ ok: true }),
    probeProxy: async (_alias, port) => ({ ok: port === 17890 }),
    startConfiguredTunnel: () => { throw new Error('no configured tunnel expected'); },
    startExplicitTunnel: (_alias, port) => { explicitPort = port; return fakeChild(); },
    delay: async () => {},
  });

  const state = await manager.ensure('gdwyy70', { force: true });
  assert.equal(explicitPort, 17890);
  assert.equal(state.route, 'proxy');
  assert.equal(state.source, 'managed-explicit-forward');
  assert.equal(state.remotePort, 17890);
  await manager.stop();
});
