import { spawn } from 'node:child_process';
import net from 'node:net';
import { normalizeConfig, parseSshUri, proxyEnvironment } from './util.js';

function processResult(command, args, { timeoutMs = 10_000, maxBytes = 128 * 1024 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout = (stdout + chunk).slice(-maxBytes); });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-maxBytes); });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, timedOut: true, error: 'timeout' });
    }, timeoutMs);
    child.once('error', (error) => finish({ code: null, timedOut: false, error: error.message }));
    child.once('exit', (code, signal) => finish({ code, signal, timedOut: false }));
  });
}

function sshArgs(target, extra = []) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
  ];
  if (target.port !== 22) args.push('-p', String(target.port));
  args.push(...extra, target.destination);
  return args;
}

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

export async function probeRemoteGitHub(uri, timeoutMs = 8_000) {
  const target = parseSshUri(uri);
  const script = [
    "if command -v curl >/dev/null 2>&1; then",
    "  curl -fsSI --connect-timeout 5 --max-time 8 https://github.com >/dev/null",
    "elif command -v git >/dev/null 2>&1; then",
    "  GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/git/git.git HEAD >/dev/null 2>&1",
    "else",
    "  exit 127",
    "fi",
  ].join('\n');
  const result = await processResult('ssh', [...sshArgs(target, ['-T']), '--', `sh -lc ${JSON.stringify(script)}`], { timeoutMs: timeoutMs + 4_000 });
  return { ok: result.code === 0, ...result };
}

async function probeRemoteProxy(uri, remotePort, timeoutMs) {
  const target = parseSshUri(uri);
  const proxy = `http://127.0.0.1:${remotePort}`;
  const script = [
    "if command -v curl >/dev/null 2>&1; then",
    `  curl -fsSI -x ${proxy} --connect-timeout 5 --max-time 8 https://github.com >/dev/null`,
    "elif command -v git >/dev/null 2>&1; then",
    `  HTTPS_PROXY=${proxy} GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/git/git.git HEAD >/dev/null 2>&1`,
    "else",
    "  exit 127",
    "fi",
  ].join('\n');
  const result = await processResult('ssh', [...sshArgs(target, ['-T']), '--', `sh -lc ${JSON.stringify(script)}`], { timeoutMs: timeoutMs + 4_000 });
  return result.code === 0;
}

function tunnelProcess(uri, remotePort, config) {
  const target = parseSshUri(uri);
  const reverse = `127.0.0.1:${remotePort}:${config.localProxyHost}:${config.localProxyPort}`;
  const args = sshArgs(target, [
    '-T', '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', reverse,
  ]);
  return spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RouteManager {
  constructor(ctx, inputConfig = {}) {
    this.ctx = ctx;
    this.config = normalizeConfig(inputConfig);
    this.mode = this.config.mode;
    this.states = new Map();
    this.unsubscribe = undefined;
    this.timer = undefined;
    this.stopped = false;
  }

  log(message) {
    const logger = typeof this.ctx?.logger === 'function' ? this.ctx.logger('ssh-vpn-bridge') : undefined;
    if (logger?.info) logger.info(message);
    else console.log(`[ssh-vpn-bridge] ${message}`);
  }

  key(uri) {
    const target = parseSshUri(uri);
    return `${target.destination}:${target.port}`;
  }

  state(uri) {
    return this.states.get(this.key(uri));
  }

  proxyEnv(uri) {
    const state = this.state(uri);
    if (!state || state.route !== 'proxy' || !state.remotePort || !state.tunnel || state.tunnel.exitCode !== null) return undefined;
    return proxyEnvironment(state.remotePort, this.config);
  }

  snapshot() {
    return [...this.states.values()].map((state) => ({
      target: state.target,
      route: state.route,
      remotePort: state.remotePort,
      directOk: state.directOk,
      localProxyOk: state.localProxyOk,
      lastCheckedAt: state.lastCheckedAt,
      error: state.error,
    }));
  }

  setMode(mode) {
    const next = String(mode || '').toLowerCase();
    if (!['auto', 'direct', 'proxy'].includes(next)) throw new Error('mode must be auto, direct, or proxy');
    this.mode = next;
  }

  async start() {
    this.unsubscribe = this.ctx.sshRemote.onStatus((change) => {
      if (change.status !== 'connected') return;
      const workspace = this.ctx.sshRemote.get(change.workspaceId);
      if (workspace?.uri) void this.ensure(workspace.uri, { force: true });
    });
    this.timer = setInterval(() => {
      for (const workspace of this.ctx.sshRemote.list()) {
        if (workspace.status !== 'connected') continue;
        const state = this.state(workspace.uri);
        if (!state || state.route === 'direct' || state.route === 'unavailable') void this.ensure(workspace.uri, { force: true });
      }
    }, this.config.healthIntervalMs);
    this.timer.unref?.();
  }

  async ensure(uri, { force = false } = {}) {
    if (this.stopped) return undefined;
    const key = this.key(uri);
    const existing = this.states.get(key);
    if (existing?.checking) return existing.checking;
    if (!force && existing && Date.now() - (existing.lastCheckedAt || 0) < 15_000) return existing;

    const target = parseSshUri(uri);
    const state = existing || { target: `${target.destination}:${target.port}`, route: 'checking' };
    this.states.set(key, state);
    state.checking = this.evaluate(uri, state).finally(() => { state.checking = undefined; });
    return state.checking;
  }

  async evaluate(uri, state) {
    state.error = undefined;
    state.lastCheckedAt = Date.now();

    if (this.mode === 'direct') {
      this.stopTunnel(state);
      state.route = 'direct';
      state.directOk = true;
      return state;
    }

    const directPromise = this.mode === 'auto' ? probeRemoteGitHub(uri, this.config.probeTimeoutMs) : Promise.resolve({ ok: false });
    const localPromise = probeLocalHttpProxy(this.config.localProxyHost, this.config.localProxyPort);
    const [direct, local] = await Promise.all([directPromise, localPromise]);
    state.directOk = Boolean(direct.ok);
    state.localProxyOk = Boolean(local.ok);

    if (this.mode === 'auto' && direct.ok) {
      this.stopTunnel(state);
      state.route = 'direct';
      this.log(`${state.target}: GitHub direct is healthy; using server network.`);
      return state;
    }

    if (!local.ok) {
      this.stopTunnel(state);
      state.route = 'unavailable';
      state.error = `Local proxy ${this.config.localProxyHost}:${this.config.localProxyPort} unavailable (${local.detail || 'probe failed'})`;
      this.log(`${state.target}: ${state.error}`);
      return state;
    }

    const tunnel = await this.ensureTunnel(uri, state);
    if (!tunnel) {
      state.route = 'unavailable';
      state.error ||= 'Could not establish a working SSH reverse proxy tunnel.';
      return state;
    }
    state.route = 'proxy';
    this.log(`${state.target}: remote tools will use Windows ${this.config.localProxyHost}:${this.config.localProxyPort} through 127.0.0.1:${state.remotePort}.`);
    return state;
  }

  async ensureTunnel(uri, state) {
    if (state.tunnel && state.tunnel.exitCode === null && state.remotePort) return state.tunnel;
    this.stopTunnel(state);

    for (let offset = 0; offset < 20; offset += 1) {
      const remotePort = this.config.remotePortStart + offset;
      const child = tunnelProcess(uri, remotePort, this.config);
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
      await delay(650);
      if (child.exitCode !== null) continue;
      const working = await probeRemoteProxy(uri, remotePort, this.config.probeTimeoutMs);
      if (!working) {
        child.kill();
        continue;
      }
      state.tunnel = child;
      state.remotePort = remotePort;
      state.stopping = false;
      child.once('exit', () => {
        if (state.tunnel !== child) return;
        state.tunnel = undefined;
        if (!state.stopping && !this.stopped && state.route === 'proxy') {
          state.error = stderr || 'SSH reverse tunnel exited.';
          setTimeout(() => void this.ensure(uri, { force: true }), 1500).unref?.();
        }
      });
      return child;
    }
    state.error = 'All candidate remote proxy ports failed.';
    return undefined;
  }

  stopTunnel(state) {
    if (!state?.tunnel) return;
    state.stopping = true;
    state.tunnel.kill();
    state.tunnel = undefined;
    state.remotePort = undefined;
  }

  async refreshAll() {
    const results = [];
    for (const workspace of this.ctx.sshRemote.list()) {
      if (workspace.status !== 'connected') continue;
      results.push(await this.ensure(workspace.uri, { force: true }));
    }
    return results;
  }

  async stop() {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    for (const state of this.states.values()) this.stopTunnel(state);
    this.states.clear();
  }
}
