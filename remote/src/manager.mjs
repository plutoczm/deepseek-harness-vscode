import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  createHarnessTunnel,
  deployPlugin,
  findLocalFreePort,
  findRemoteFreePort,
  resolveRemoteNode,
  runSsh,
  waitForHttp,
} from './ssh.mjs';
import { validateHost, validateRemotePath } from './config.mjs';
import { clearRemoteProxyEnvironment, startLocalProxyBridge } from './network.mjs';
import { accumulateUsage } from './usage-cost.mjs';

const MAX_LOG_CHARS = 250_000;
const USAGE_MARKER = '__DHR_USAGE__';
const BALANCE_MARKER = '__DHR_BALANCE__';
const TERMINAL_STATUSES = new Set(['stopped', 'error']);
const REMOTE_CLEANUP_DELAYS_MS = [0, 1500, 5000, 15000];

export function normalizeProcessExitCode(code) {
  if (code === null || code === undefined || !Number.isInteger(code)) return code;
  return code > 0x7fffffff ? code - 0x100000000 : code;
}

export function sshExitMessage(code, signal) {
  const normalized = normalizeProcessExitCode(code);
  if (normalized === 255) return 'SSH connection lost (exit 255). Harness was stopped with the SSH tunnel.';
  if (normalized === -1) return 'SSH process terminated unexpectedly (Windows exit -1). Harness was stopped with the SSH tunnel.';
  if (signal) return `SSH/Harness terminated by ${signal}.`;
  if (normalized === 0) return 'SSH/Harness session ended.';
  return `SSH/Harness exited with code ${normalized}.`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export class HarnessManager extends EventEmitter {
  constructor(pluginDirectory) {
    super();
    this.pluginDirectory = pluginDirectory;
    this.instances = new Map();
  }

  publicInstance(instance) {
    return {
      id: instance.id,
      host: instance.host,
      workspace: instance.workspace,
      status: instance.status,
      localPort: instance.localPort,
      remotePort: instance.remotePort,
      url: instance.localPort ? `http://127.0.0.1:${instance.localPort}` : undefined,
      nodeVersion: instance.nodeVersion,
      nodeSource: instance.nodeSource,
      createdAt: instance.createdAt,
      endedAt: instance.endedAt,
      exitCode: instance.exitCode,
      exitSignal: instance.exitSignal,
      error: instance.error,
      usageAvailable: Boolean(instance.latestUsageSessionId),
      balanceAvailable: Boolean(instance.balanceSnapshot?.ok),
      network: instance.network ? {
        enabled: Boolean(instance.network.enabled),
        mode: instance.network.mode || 'remote-direct',
        localProxyHost: instance.network.localProxyHost,
        localProxyPort: instance.network.localProxyPort,
        remoteProxyPort: instance.network.remoteProxyPort,
      } : { enabled: false, mode: 'remote-direct' },
    };
  }

  emitInstanceStatus(instance) {
    this.emit('instance-status', {
      instanceId: instance.id,
      instance: this.publicInstance(instance),
    });
  }

  onInstanceStatus(id, listener) {
    const handler = (event) => {
      if (!id || event.instanceId === id) listener(event.instance);
    };
    this.on('instance-status', handler);
    return () => this.off('instance-status', handler);
  }

  list() {
    return [...this.instances.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => this.publicInstance(item));
  }

  get(id) {
    const instance = this.instances.get(id);
    return instance ? this.publicInstance(instance) : undefined;
  }

  logs(id) {
    return this.instances.get(id)?.logs ?? '';
  }

  usage(id) {
    const instance = this.instances.get(id);
    if (!instance) return undefined;
    const sessions = [...(instance.usageSessions?.values() ?? [])]
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const latest = instance.latestUsageSessionId
      ? instance.usageSessions?.get(instance.latestUsageSessionId)
      : sessions[0];
    return {
      available: sessions.length > 0,
      active: !TERMINAL_STATUSES.has(instance.status),
      mode: 'event-driven',
      latestSessionId: instance.latestUsageSessionId || null,
      session: latest || null,
      sessions,
      updatedAt: latest?.updatedAt || null,
    };
  }

  onUsage(id, listener) {
    const handler = (event) => {
      if (event.instanceId === id) listener(event.snapshot);
    };
    this.on('usage', handler);
    return () => this.off('usage', handler);
  }

  balance(id) {
    const instance = this.instances.get(id);
    if (!instance) return undefined;
    const snapshot = instance.balanceSnapshot;
    return {
      received: Boolean(snapshot),
      active: !TERMINAL_STATUSES.has(instance.status),
      ok: Boolean(snapshot?.ok),
      available: snapshot?.available ?? null,
      currency: snapshot?.currency || null,
      total: optionalNumber(snapshot?.total),
      granted: optionalNumber(snapshot?.granted),
      toppedUp: optionalNumber(snapshot?.toppedUp),
      error: snapshot?.error || null,
      fetchedAt: snapshot?.fetchedAt || null,
    };
  }

  onBalance(id, listener) {
    const handler = (event) => {
      if (event.instanceId === id) listener(event.snapshot);
    };
    this.on('balance', handler);
    return () => this.off('balance', handler);
  }

  appendLog(instance, chunk) {
    instance.logs += chunk;
    if (instance.logs.length > MAX_LOG_CHARS) instance.logs = instance.logs.slice(-MAX_LOG_CHARS);
  }

  consumeUsageLine(instance, line) {
    if (!line.startsWith(USAGE_MARKER)) return false;
    const encoded = line.slice(USAGE_MARKER.length).trim();
    if (!encoded) return true;
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      const sessionId = String(payload?.sessionId || '');
      if (!sessionId) return true;
      const previous = instance.usageSessions.get(sessionId);
      const next = accumulateUsage(previous, payload);
      instance.usageSessions.set(sessionId, next);
      instance.latestUsageSessionId = sessionId;
      const snapshot = this.usage(instance.id);
      this.emit('usage', { instanceId: instance.id, snapshot, event: next.last });
    } catch (error) {
      this.appendLog(instance, `[usage] Could not decode Harness usage event: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return true;
  }

  consumeBalanceLine(instance, line) {
    if (!line.startsWith(BALANCE_MARKER)) return false;
    const encoded = line.slice(BALANCE_MARKER.length).trim();
    if (!encoded) return true;
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      instance.balanceSnapshot = payload && typeof payload === 'object' ? payload : undefined;
      this.emit('balance', {
        instanceId: instance.id,
        snapshot: this.balance(instance.id),
      });
    } catch (error) {
      this.appendLog(instance, `[balance] Could not decode DeepSeek balance event: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return true;
  }

  consumeTelemetryLine(instance, line) {
    return this.consumeUsageLine(instance, line) || this.consumeBalanceLine(instance, line);
  }

  handleHarnessStdout(instance, chunk) {
    const text = `${instance.stdoutBuffer || ''}${String(chunk)}`;
    const lines = text.split(/\r?\n/u);
    instance.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!this.consumeTelemetryLine(instance, line)) this.appendLog(instance, `${line}\n`);
    }
  }

  flushHarnessStdout(instance) {
    const line = instance.stdoutBuffer || '';
    instance.stdoutBuffer = '';
    if (line && !this.consumeTelemetryLine(instance, line)) this.appendLog(instance, line);
  }

  remoteCleanupScript(instance) {
    const marker = shellQuote(`DEEPSEEK_HARNESS_REMOTE_INSTANCE=${instance.id}`);
    return `set +e\nMARKER=${marker}\nPIDS=''\nfor ENVFILE in /proc/[0-9]*/environ; do\n  PID=\"\${ENVFILE#/proc/}\"\n  PID=\"\${PID%/environ}\"\n  [ \"$PID\" = \"$$\" ] && continue\n  [ -r \"$ENVFILE\" ] || continue\n  if tr '\\0' '\\n' < \"$ENVFILE\" 2>/dev/null | grep -Fqx -- \"$MARKER\"; then\n    PIDS=\"$PIDS $PID\"\n  fi\ndone\nif [ -n \"$PIDS\" ]; then\n  kill -TERM $PIDS 2>/dev/null || true\n  sleep 0.35\n  for PID in $PIDS; do kill -0 \"$PID\" 2>/dev/null && kill -KILL \"$PID\" 2>/dev/null || true; done\nfi\nexit 0\n`;
  }

  async cleanupRemoteHarness(instance, { quiet = false } = {}) {
    if (!instance?.id || !instance?.host) return false;
    try {
      await runSsh(instance.host, this.remoteCleanupScript(instance), { timeoutMs: 9000, maxBytes: 64 * 1024 });
      if (!quiet) this.appendLog(instance, '[lifecycle] Remote Harness processes for this instance were cleaned up.\n');
      return true;
    } catch (error) {
      if (!quiet) this.appendLog(instance, `[lifecycle] Remote cleanup could not connect yet: ${error instanceof Error ? error.message : String(error)}\n`);
      return false;
    }
  }

  scheduleRemoteCleanup(instance) {
    if (instance.remoteCleanupScheduled) return;
    instance.remoteCleanupScheduled = true;
    REMOTE_CLEANUP_DELAYS_MS.forEach((delay, index) => {
      const timer = setTimeout(async () => {
        if (instance.remoteCleanupDone) return;
        const cleaned = await this.cleanupRemoteHarness(instance, { quiet: index > 0 });
        if (cleaned) instance.remoteCleanupDone = true;
      }, delay);
      timer.unref?.();
    });
  }

  markEnded(instance, status, { code, signal, error } = {}) {
    instance.status = status;
    instance.endedAt ||= new Date().toISOString();
    instance.exitCode = normalizeProcessExitCode(code);
    instance.exitSignal = signal || undefined;
    if (error) instance.error = error;
    this.emitInstanceStatus(instance);
    const usageSnapshot = this.usage(instance.id);
    this.emit('usage', { instanceId: instance.id, snapshot: usageSnapshot, event: null });
    const balanceSnapshot = this.balance(instance.id);
    this.emit('balance', { instanceId: instance.id, snapshot: balanceSnapshot });
  }

  async launch({ host: hostInput, workspace: workspaceInput, installRuntime = true, enableLocalProxy = false }) {
    const host = validateHost(hostInput);
    const workspace = validateRemotePath(workspaceInput);
    const instance = {
      id: randomUUID(),
      host,
      workspace,
      status: 'preparing',
      logs: '',
      stdoutBuffer: '',
      usageSessions: new Map(),
      latestUsageSessionId: undefined,
      balanceSnapshot: undefined,
      createdAt: new Date().toISOString(),
      network: { enabled: false, mode: 'remote-direct' },
    };
    this.instances.set(instance.id, instance);
    this.emitInstanceStatus(instance);

    try {
      this.appendLog(instance, `[launcher] Connecting to ${host}\n`);
      const runtime = await resolveRemoteNode(host, { installIfMissing: installRuntime });
      if (!runtime.path && runtime.source === 'missing') {
        throw new Error(`Remote Node.js is ${runtime.version || 'unavailable'}. DeepSeek Harness requires Node.js >= 22.19.0. Install the private runtime and retry.`);
      }
      if (runtime.path?.startsWith('$HOME/') && runtime.info?.home) {
        runtime.path = `${runtime.info.home}/${runtime.path.slice('$HOME/'.length)}`;
      }
      instance.nodeVersion = runtime.version;
      instance.nodeSource = runtime.source;
      this.appendLog(instance, `[launcher] Node ${runtime.version} (${runtime.source})\n`);
      if (runtime.path) this.appendLog(instance, `[launcher] Node bin ${runtime.path}\n`);
      if (runtime.condaPath) this.appendLog(instance, `[launcher] Conda ${runtime.condaPath}\n`);

      await deployPlugin(host, this.pluginDirectory);
      this.appendLog(instance, '[launcher] Session environment, usage and balance telemetry plugins deployed.\n');

      if (enableLocalProxy) {
        try {
          instance.network = await startLocalProxyBridge({
            host,
            instanceId: instance.id,
            runtimeBin: runtime.path,
            onLog: (chunk) => this.appendLog(instance, chunk),
          });
        } catch (error) {
          instance.network = { enabled: false, mode: 'remote-direct', localProxyHost: '127.0.0.1', localProxyPort: 7890 };
          this.appendLog(instance, `[network] Requested local proxy bridge could not be enabled: ${error instanceof Error ? error.message : String(error)}\n`);
          this.appendLog(instance, '[network] Falling back to the remote server network.\n');
        }
      } else {
        this.appendLog(instance, '[network] Remote-direct mode. Local VPN/proxy bridge is disabled for this instance.\n');
      }

      const [localPort, remotePort] = await Promise.all([
        findLocalFreePort(),
        findRemoteFreePort(host, runtime.path),
      ]);
      instance.localPort = localPort;
      instance.remotePort = remotePort;
      instance.status = 'starting';
      this.emitInstanceStatus(instance);
      this.appendLog(instance, `[launcher] SSH tunnel 127.0.0.1:${localPort} -> ${host}:127.0.0.1:${remotePort}\n`);

      const child = createHarnessTunnel({
        host,
        workspace,
        localPort,
        remotePort,
        runtimeBin: runtime.path,
        condaPath: runtime.condaPath,
        instanceId: instance.id,
        onStdout: (chunk) => this.handleHarnessStdout(instance, chunk),
        onLog: (chunk) => this.appendLog(instance, chunk),
      });
      instance.child = child;
      child.once('error', (error) => {
        if (TERMINAL_STATUSES.has(instance.status)) return;
        this.appendLog(instance, `[launcher] SSH process error: ${error.message}\n`);
        this.markEnded(instance, 'error', { error: `SSH process error: ${error.message}` });
        this.scheduleRemoteCleanup(instance);
      });
      child.once('exit', (code, signal) => {
        this.flushHarnessStdout(instance);
        const normalized = normalizeProcessExitCode(code);
        instance.exitCode = normalized;
        instance.exitSignal = signal || undefined;
        this.appendLog(instance, `[launcher] SSH/Harness exited${normalized !== null && normalized !== undefined ? ` code=${normalized}` : ''}${signal ? ` signal=${signal}` : ''}.\n`);
        if (instance.status === 'stopping' || instance.status === 'stopped') return;
        const status = normalized === 0 ? 'stopped' : 'error';
        this.markEnded(instance, status, {
          code,
          signal,
          error: normalized === 0 ? undefined : sshExitMessage(code, signal),
        });
        this.scheduleRemoteCleanup(instance);
        const proxyChild = instance.network?.child;
        if (proxyChild && proxyChild.exitCode === null) proxyChild.kill('SIGTERM');
        if (instance.network?.enabled) clearRemoteProxyEnvironment(instance.host, instance.id).catch(() => undefined);
      });

      await waitForHttp(localPort, { child, timeoutMs: 180000 });
      if (child.exitCode !== null || TERMINAL_STATUSES.has(instance.status)) {
        throw new Error(instance.error || sshExitMessage(child.exitCode, child.signalCode));
      }
      instance.status = 'running';
      this.emitInstanceStatus(instance);
      this.appendLog(instance, `[launcher] Harness ready: http://127.0.0.1:${localPort}\n`);
      this.appendLog(instance, '[usage] Event-driven DeepSeek session-cost tracking is active.\n');
      this.appendLog(instance, '[balance] DeepSeek /user/balance refreshes at startup, every 30s, and after usage; balance checks do not call a model or consume tokens.\n');
      this.appendLog(instance, '[launcher] Each Harness session will ask for its Python/Conda environment on first Bash use. Use /env to change it later.\n');
      return this.publicInstance(instance);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!TERMINAL_STATUSES.has(instance.status)) this.markEnded(instance, 'error', { error: message });
      else if (!instance.error) instance.error = message;
      this.appendLog(instance, `[launcher] ERROR: ${instance.error}\n`);
      if (instance.child?.exitCode === null) instance.child.kill('SIGTERM');
      if (instance.network?.child?.exitCode === null) instance.network.child.kill('SIGTERM');
      if (instance.network?.enabled) await clearRemoteProxyEnvironment(instance.host, instance.id).catch(() => undefined);
      this.scheduleRemoteCleanup(instance);
      throw Object.assign(new Error(instance.error), { instanceId: instance.id });
    }
  }

  async stop(id) {
    const instance = this.instances.get(id);
    if (!instance) return false;
    if (instance.status === 'stopped') return true;
    instance.status = 'stopping';
    this.emitInstanceStatus(instance);
    const child = instance.child;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    this.flushHarnessStdout(instance);
    await this.cleanupRemoteHarness(instance).catch(() => undefined);
    instance.remoteCleanupDone = true;
    const proxyChild = instance.network?.child;
    if (proxyChild && proxyChild.exitCode === null) proxyChild.kill('SIGTERM');
    if (instance.network?.enabled) await clearRemoteProxyEnvironment(instance.host, instance.id).catch(() => undefined);
    this.markEnded(instance, 'stopped', { code: child?.exitCode, signal: child?.signalCode });
    this.appendLog(instance, '[launcher] Stopped. SSH tunnel and remote Harness are now both closed.\n');
    return true;
  }

  async stopAll() {
    await Promise.all([...this.instances.keys()].map((id) => this.stop(id)));
  }
}
