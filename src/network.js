import net from 'node:net';
import {
  probeRemoteGitHub,
  probeRemoteProxy,
  probeRemoteRoute,
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

function sshTransportSucceeded(result) {
  return Boolean(
    result
    && result.timedOut !== true
    && result.exitCode !== null
    && result.exitCode !== undefined
    && result.exitCode !== 255,
  );
}

/** Compatibility adapter for unit tests and third-party injected probes. */
function legacyRouteProbe(adapters) {
  return async (alias, { includeDirect = true, proxyPort, timeoutMs = 8_000 } = {}) => {
    const direct = includeDirect
      ? await adapters.probeDirect(alias, timeoutMs)
      : undefined;
    const proxy = Number(proxyPort) > 0
      ? await adapters.probeProxy(alias, Number(proxyPort), timeoutMs)
      : undefined;
    const hint = proxy || direct;

    let sshOk = Boolean(hint?.ok || sshTransportSucceeded(hint));
    let baseline = hint;
    if (!sshOk) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0 || hint) await adapters.delay(attempt === 0 ? 750 : 1200);
        baseline = await adapters.probeSsh(alias, timeoutMs);
        if (baseline?.ok) {
          sshOk = true;
          break;
        }
      }
    }

    return {
      ...(baseline || {}),
      ok: sshOk,
      sshOk,
      directOk: Boolean(direct?.ok),
      proxyOk: Boolean(proxy?.ok),
    };
  };
}

/**
 * Network policy for one or more native OpenSSH aliases.
 *
 * On the real Windows+aTrust target, opening several SSH sessions back-to-back
 * can cause banner/KEX resets even though a standalone ssh command succeeds.
 * Production therefore performs direct GitHub, configured RemoteForward and
 * authenticated SSH-baseline checks in one remote shell via probeRemoteRoute.
 * A failed transport gets only one delayed retry.
 *
 * Ordinary SSH exec/probe calls use ClearAllForwardings=yes, so they never
 * recreate configured RemoteForward entries or fight VS Code for port 35052.
 */
export class RouteManager {
  constructor(ctx, inputConfig = {}, adapters = {}) {
    this.ctx = ctx;
    this.config = normalizeConfig(inputConfig);
    this.mode = this.config.mode;
    this.states = new Map();
    this.timer = undefined;
    this.stopped = false;

    const merged = {
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
    const hasLegacyProbeOverrides = !adapters.probeRoute
      && ['probeDirect', 'probeProxy', 'probeSsh'].some((key) => Object.prototype.hasOwnProperty.call(adapters, key));
    merged.probeRoute = adapters.probeRoute
      || (hasLegacyProbeOverrides ? legacyRouteProbe(merged) : probeRemoteRoute);
    this.routeProbeAttempts = hasLegacyProbeOverrides ? 1 : 2;
    this.adapters = merged;
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

  async probeRouteWithBackoff(alias, options) {
    let last;
    for (let attempt = 0; attempt < this.routeProbeAttempts; attempt += 1) {
      if (attempt > 0) await this.adapters.delay(1200);
      last = await this.adapters.probeRoute(alias, options);
      if (last?.sshOk) return last;
    }
    return last || { ok: false, sshOk: false, error: 'authenticated SSH route probe failed' };
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

    const configured = state.configuredForward;
    const managedAlive = childAlive(state.tunnel) && Number(state.remotePort) > 0;
    const probePort = managedAlive
      ? state.remotePort
      : configured?.listenPort;

    const [remote, local] = await Promise.all([
      this.probeRouteWithBackoff(alias, {
        includeDirect: this.mode === 'auto',
        proxyPort: probePort,
        timeoutMs: this.config.probeTimeoutMs,
      }),
      this.adapters.probeLocal(this.config.localProxyHost, this.config.localProxyPort),
    ]);

    state.directOk = Boolean(remote?.directOk);
    state.sshOk = Boolean(remote?.sshOk);
    state.localProxyOk = Boolean(local?.ok);
    state.localProxyDetail = local?.detail;

    if (state.sshOk && this.mode === 'auto' && remote?.directOk) {
      this.stopManagedTunnel(state);
      state.route = 'direct';
      state.source = 'remote-direct';
      state.remotePort = undefined;
      state.error = undefined;
      this.log(`${alias}: GitHub direct is healthy; using the server network.`);
      return state;
    }

    if (state.sshOk && probePort && remote?.proxyOk) {
      state.route = 'proxy';
      state.source = managedAlive
        ? (state.tunnelSource || 'managed')
        : 'existing-config-forward';
      state.remotePort = Number(probePort);
      state.localProxyOk = true;
      state.error = undefined;
      if (!managedAlive) {
        this.log(`${alias}: reusing existing RemoteForward 127.0.0.1:${probePort} -> ${this.config.localProxyHost}:${this.config.localProxyPort}.`);
      }
      return state;
    }

    // A transient control-SSH health probe must not kill an already-running
    // managed tunnel. Keep ownership and retry on the next health cycle.
    if (managedAlive && !state.sshOk) {
      state.route = 'proxy';
      state.source = state.tunnelSource || 'managed';
      state.error = `SSH health probe unavailable; keeping live managed tunnel: ${resultError(remote, 'transport failed')}`;
      return state;
    }

    if (managedAlive) this.stopManagedTunnel(state);

    if (!local?.ok) {
      state.route = 'unavailable';
      state.source = 'local-proxy-unavailable';
      state.remotePort = undefined;
      state.error = `Local proxy ${this.config.localProxyHost}:${this.config.localProxyPort} unavailable (${local?.detail || 'probe failed'})`;
      this.log(`${alias}: ${state.error}`);
      return state;
    }

    if (!state.sshOk) {
      state.route = 'unavailable';
      state.source = 'ssh-unavailable';
      state.remotePort = undefined;
      state.error = `SSH baseline unavailable: ${resultError(remote, 'authenticated SSH exec failed')}`;
      this.log(`${alias}: ${state.error}`);
      return state;
    }

    // Give aTrust / corporate VNIC stacks a short quiet period between the
    // route-probe connection and the long-lived tunnel-owner handshake.
    await this.adapters.delay(900);

    if (configured) {
      const managed = await this.tryConfiguredTunnel(alias, state, configured.listenPort);
      if (managed) return state;

      const raced = await this.adapters.probeProxy(alias, configured.listenPort, this.config.probeTimeoutMs);
      if (raced?.ok) {
        this.stopManagedTunnel(state);
        state.route = 'proxy';
        state.source = 'existing-config-forward';
        state.remotePort = configured.listenPort;
        state.error = undefined;
        return state;
      }

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

    // Avoid immediately opening another short-lived SSH while the new -N owner
    // is still completing KEX/authentication.
    await this.adapters.delay(900);

    while (Date.now() - started < timeoutMs) {
      if (!childAlive(state.tunnel)) {
        return {
          ok: false,
          error: state.tunnelStderr?.trim() || 'SSH tunnel process exited before the forward became ready',
        };
      }

      lastProbe = await this.adapters.probeProxy(alias, remotePort, Math.min(2_500, timeoutMs));
      if (lastProbe?.ok) return { ok: true };
      const transportReset = lastProbe?.exitCode === 255;
      await this.adapters.delay(transportReset ? 1200 : 500);
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
