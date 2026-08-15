import net from 'node:net';
import {
  probeRemoteGitHub,
  probeRemoteProxy,
  probeSshBaseline,
  resolveOpenSshConfig,
  startConfiguredTunnel,
  startExplicitTunnel,
} from './openssh.js';
import { matchingProxyForward, normalizeConfig, proxyEnvironment } from './util.js';

export function probeLocalHttpProxy(host = '127.0.0.1', port = 7890, timeoutMs = 3500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setEncoding('utf8');
    let buffer = '';
    let settled = false;
    const finish = (ok, detail = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok, host, port, detail });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    socket.once('error', (error) => finish(false, error.message));
    socket.once('connect', () => {
      socket.write('CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nProxy-Connection: close\r\n\r\n');
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const firstLine = buffer.split(/\r?\n/u)[0] || '';
      if (/^HTTP\/1\.[01] 2\d\d\b/u.test(firstLine)) finish(true, firstLine);
      else if (/^HTTP\/1\.[01] \d{3}\b/u.test(firstLine)) finish(false, firstLine);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childAlive(child) {
  return child && child.exitCode === null;
}

function resultError(result, fallback) {
  return result?.stderr?.trim() || result?.error || fallback;
}

function isManagedSource(source) {
  return typeof source === 'string' && source.startsWith('managed-');
}

/**
 * Network policy for one or more native OpenSSH aliases.
 *
 * Priority in auto mode:
 * 1. remote GitHub direct;
 * 2. a healthy reverse tunnel already owned by this RouteManager;
 * 3. an already-live external RemoteForward from `ssh -G`;
 * 4. verify that a fresh authenticated SSH exec still works;
 * 5. start exactly one configured-forward owner when a matching RemoteForward
 *    exists, otherwise create a verified reverse-forward candidate at 17890+.
 *
 * Ordinary SSH exec/probe calls are made with ClearAllForwardings=yes by
 * openssh.js, so they never fight VS Code for the configured listen port.
 */
export class RouteManager {
  constructor(ctx, inputConfig = {}, adapters = {}) {
    this.ctx = ctx;
    this.config = normalizeConfig(inputConfig);
    this.mode = this.config.mode;
    this.states = new Map();
    this.timer = undefined;
    this.stopped = false;
    this.adapters = {
      resolve: resolveOpenSshConfig,
      probeDirect: probeRemoteGitHub,
      probeProxy: probeRemoteProxy,
      probeSsh: probeSshBaseline,
      probeLocal: probeLocalHttpProxy,
      startConfiguredTunnel,
      startExplicitTunnel,
      delay,
      ...adapters,
    };
  }

  log(message) {
    const logger = typeof this.ctx?.logger === 'function' ? this.ctx.logger('dsh-openssh-vpn') : undefined;
    if (logger?.info) logger.info(message);
    else console.log(`[dsh-openssh-vpn] ${message}`);
  }

  state(alias) {
    return this.states.get(String(alias));
  }

  proxyEnv(alias) {
    const state = this.state(alias);
    if (!state || state.route !== 'proxy' || !state.remotePort) return undefined;
    return proxyEnvironment(state.remotePort, this.config);
  }

  snapshot(alias) {
    const values = alias ? [this.state(alias)].filter(Boolean) : [...this.states.values()];
    return values.map((state) => ({
      alias: state.alias,
      target: state.target,
      route: state.route,
      source: state.source,
      remotePort: state.remotePort,
      directOk: state.directOk,
      sshOk: state.sshOk,
      localProxyOk: state.localProxyOk,
      localProxyDetail: state.localProxyDetail,
      configuredForward: state.configuredForward,
      managedTunnelAlive: childAlive(state.tunnel),
      managedTunnelPid: childAlive(state.tunnel) ? state.tunnel?.pid : undefined,
      lastCheckedAt: state.lastCheckedAt,
      error: state.error,
    }));
  }

  setMode(mode) {
    const next = String(mode || '').toLowerCase();
    if (!['auto', 'direct', 'proxy'].includes(next)) throw new Error('mode must be auto, direct, or proxy');
    this.mode = next;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const alias of this.states.keys()) void this.ensure(alias, { force: true });
    }, this.config.healthIntervalMs);
    this.timer.unref?.();
  }

  async ensure(alias, { force = false } = {}) {
    if (this.stopped) return undefined;
    const key = String(alias || '').trim();
    if (!key) throw new Error('SSH alias is required');
    const existing = this.states.get(key);
    if (existing?.checking) return existing.checking;

    const recent = existing && Date.now() - (existing.lastCheckedAt || 0) < 15_000;
    const deadManagedTunnel = existing?.route === 'proxy'
      && isManagedSource(existing.source)
      && !childAlive(existing.tunnel);
    if (!force && recent && existing.route !== 'unavailable' && !deadManagedTunnel) return existing;

    const state = existing || { alias: key, route: 'checking' };
    this.states.set(key, state);
    state.checking = this.evaluate(key, state).finally(() => { state.checking = undefined; });
    return state.checking;
  }

  async evaluate(alias, state) {
    state.error = undefined;
    state.lastCheckedAt = Date.now();

    let resolved;
    try {
      resolved = await this.adapters.resolve(alias, this.config.probeTimeoutMs);
      state.target = `${resolved.user ? `${resolved.user}@` : ''}${resolved.hostname}:${resolved.port}`;
      state.configuredForward = matchingProxyForward(resolved, this.config);
    } catch (error) {
      this.stopManagedTunnel(state);
      state.route = 'unavailable';
      state.source = 'config-unavailable';
      state.error = error instanceof Error ? error.message : String(error);
      return state;
    }

    if (this.mode === 'direct') {
      this.stopManagedTunnel(state);
      state.route = 'direct';
      state.source = 'forced-direct';
      state.directOk = true;
      state.sshOk = undefined;
      return state;
    }

    const directPromise = this.mode === 'auto'
      ? this.adapters.probeDirect(alias, this.config.probeTimeoutMs)
      : Promise.resolve({ ok: false });
    const localPromise = this.adapters.probeLocal(this.config.localProxyHost, this.config.localProxyPort);
    const [direct, local] = await Promise.all([directPromise, localPromise]);
    state.directOk = Boolean(direct?.ok);
    state.localProxyOk = Boolean(local?.ok);
    state.localProxyDetail = local?.detail;

    if (this.mode === 'auto' && direct?.ok) {
      this.stopManagedTunnel(state);
      state.route = 'direct';
      state.source = 'remote-direct';
      state.remotePort = undefined;
      state.sshOk = true;
      this.log(`${alias}: GitHub direct is healthy; using the server network.`);
      return state;
    }

    // A tunnel owned by this RouteManager must be checked before probing for an
    // "external" configured forward. Otherwise our own 35052 looks external,
    // gets classified as existing-config-forward, and stopManagedTunnel() kills
    // the very tunnel that made the probe succeed.
    if (childAlive(state.tunnel) && state.remotePort) {
      const healthy = await this.adapters.probeProxy(alias, state.remotePort, this.config.probeTimeoutMs);
      if (healthy?.ok) {
        state.route = 'proxy';
        state.source = state.tunnelSource || 'managed';
        state.sshOk = true;
        state.error = undefined;
        return state;
      }
      this.stopManagedTunnel(state);
    }

    // If an external process (for example VS Code Remote SSH) already owns the
    // configured RemoteForward and it works end-to-end, that is authoritative.
    const configured = state.configuredForward;
    if (configured) {
      const existingProxy = await this.adapters.probeProxy(alias, configured.listenPort, this.config.probeTimeoutMs);
      if (existingProxy?.ok) {
        state.route = 'proxy';
        state.source = 'existing-config-forward';
        state.remotePort = configured.listenPort;
        state.sshOk = true;
        this.log(`${alias}: reusing existing RemoteForward 127.0.0.1:${configured.listenPort} -> ${this.config.localProxyHost}:${this.config.localProxyPort}.`);
        return state;
      }
    }

    if (!local?.ok) {
      this.stopManagedTunnel(state);
      state.route = 'unavailable';
      state.source = 'local-proxy-unavailable';
      state.remotePort = undefined;
      state.error = `Local proxy ${this.config.localProxyHost}:${this.config.localProxyPort} unavailable (${local?.detail || 'probe failed'})`;
      this.log(`${alias}: ${state.error}`);
      return state;
    }

    // Never hammer candidate reverse-forward ports when the base SSH transport
    // itself is failing (e.g. TCP/banner reset through a corporate VNIC).
    const baseline = await this.adapters.probeSsh(alias, this.config.probeTimeoutMs);
    state.sshOk = Boolean(baseline?.ok);
    if (!baseline?.ok) {
      state.route = 'unavailable';
      state.source = 'ssh-unavailable';
      state.remotePort = undefined;
      state.error = `SSH baseline unavailable: ${resultError(baseline, 'authenticated SSH exec failed')}`;
      this.log(`${alias}: ${state.error}`);
      return state;
    }

    if (configured) {
      const managed = await this.tryConfiguredTunnel(alias, state, configured.listenPort);
      if (managed) return state;

      // A second Harness/VS Code process may have won the bind race after our
      // initial external probe. Re-probe once and reuse the winner rather than
      // opening a second, unrelated fallback port.
      const raced = await this.adapters.probeProxy(alias, configured.listenPort, this.config.probeTimeoutMs);
      if (raced?.ok) {
        this.stopManagedTunnel(state);
        state.route = 'proxy';
        state.source = 'existing-config-forward';
        state.remotePort = configured.listenPort;
        state.error = undefined;
        return state;
      }

      // A matching explicit OpenSSH RemoteForward is authoritative. If it
      // cannot be owned, fail with its exact diagnostics rather than silently
      // moving to 17890 and creating a second proxy convention for this host.
      state.route = 'unavailable';
      state.source = 'configured-forward-unavailable';
      state.remotePort = undefined;
      return state;
    }

    const explicit = await this.tryExplicitTunnel(alias, state);
    if (explicit) return state;

    state.route = 'unavailable';
    state.source = 'fallback-unavailable';
    state.remotePort = undefined;
    state.error ||= 'Could not establish a working SSH reverse proxy tunnel.';
    return state;
  }

  attachTunnel(state, child, source, remotePort) {
    let stderr = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
      state.tunnelStderr = stderr;
    });
    state.tunnel = child;
    state.tunnelSource = source;
    state.remotePort = remotePort;
    state.stopping = false;
    state.tunnelStderr = '';
    child.once?.('exit', () => {
      if (state.tunnel !== child) return;
      state.tunnel = undefined;
      state.tunnelSource = undefined;
      if (!state.stopping && !this.stopped) {
        state.route = 'unavailable';
        state.source = 'managed-tunnel-exited';
        state.remotePort = undefined;
        state.sshOk = undefined;
        state.lastCheckedAt = 0;
        state.error = stderr.trim() || 'managed SSH reverse tunnel exited';
        setTimeout(() => void this.ensure(state.alias, { force: true }), 1500).unref?.();
      }
    });
  }

  async waitForTunnel(alias, state, remotePort) {
    const started = Date.now();
    const timeoutMs = Math.max(2_000, this.config.probeTimeoutMs);
    let lastProbe;

    while (Date.now() - started < timeoutMs) {
      if (!childAlive(state.tunnel)) {
        return {
          ok: false,
          error: state.tunnelStderr?.trim() || 'SSH tunnel process exited before the forward became ready',
        };
      }

      lastProbe = await this.adapters.probeProxy(alias, remotePort, Math.min(2_500, timeoutMs));
      if (lastProbe?.ok) return { ok: true };
      await this.adapters.delay(350);
    }

    return {
      ok: false,
      error: state.tunnelStderr?.trim()
        || lastProbe?.stderr?.trim()
        || lastProbe?.error
        || `remote proxy 127.0.0.1:${remotePort} did not become ready within ${timeoutMs} ms`,
    };
  }

  async tryConfiguredTunnel(alias, state, remotePort) {
    this.stopManagedTunnel(state);
    const child = this.adapters.startConfiguredTunnel(alias);
    this.attachTunnel(state, child, 'managed-config-forward', remotePort);
    const ready = await this.waitForTunnel(alias, state, remotePort);
    if (!ready.ok) {
      state.error = `Configured RemoteForward ${remotePort} failed: ${ready.error}`;
      this.stopManagedTunnel(state);
      return false;
    }
    state.route = 'proxy';
    state.source = 'managed-config-forward';
    state.error = undefined;
    this.log(`${alias}: started configured RemoteForward on 127.0.0.1:${remotePort}.`);
    return true;
  }

  async tryExplicitTunnel(alias, state) {
    this.stopManagedTunnel(state);
    let lastError = state.error;
    for (let offset = 0; offset < 20; offset += 1) {
      const remotePort = this.config.remotePortStart + offset;
      const child = this.adapters.startExplicitTunnel(
        alias,
        remotePort,
        this.config.localProxyHost,
        this.config.localProxyPort,
      );
      this.attachTunnel(state, child, 'managed-explicit-forward', remotePort);
      const ready = await this.waitForTunnel(alias, state, remotePort);
      if (!ready.ok) {
        lastError = `Fallback RemoteForward ${remotePort} failed: ${ready.error}`;
        this.stopManagedTunnel(state);
        continue;
      }
      state.route = 'proxy';
      state.source = 'managed-explicit-forward';
      state.error = undefined;
      this.log(`${alias}: opened fallback reverse proxy 127.0.0.1:${remotePort} -> ${this.config.localProxyHost}:${this.config.localProxyPort}.`);
      return true;
    }
    state.error = lastError || 'All candidate fallback proxy ports failed.';
    return false;
  }

  stopManagedTunnel(state) {
    if (!state?.tunnel) return;
    state.stopping = true;
    try { state.tunnel.kill(); } catch { /* already gone */ }
    state.tunnel = undefined;
    state.tunnelSource = undefined;
  }

  async refreshAll() {
    const results = [];
    for (const alias of this.states.keys()) results.push(await this.ensure(alias, { force: true }));
    return results;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const state of this.states.values()) this.stopManagedTunnel(state);
    this.states.clear();
  }
}
