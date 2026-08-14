import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  createHarnessTunnel,
  deployPlugin,
  findLocalFreePort,
  findRemoteFreePort,
  resolveRemoteNode,
  waitForHttp,
} from './ssh.mjs';
import { validateHost, validateRemotePath } from './config.mjs';
import { clearRemoteProxyEnvironment, startLocalProxyBridge } from './network.mjs';
import { accumulateUsage } from './usage-cost.mjs';

const MAX_LOG_CHARS = 250_000;
const USAGE_MARKER = '__DHR_USAGE__';

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
      error: instance.error,
      usageAvailable: Boolean(instance.latestUsageSessionId),
      network: instance.network ? {
        enabled: Boolean(instance.network.enabled),
        mode: instance.network.mode || 'remote-direct',
        localProxyHost: instance.network.localProxyHost,
        localProxyPort: instance.network.localProxyPort,
        remoteProxyPort: instance.network.remoteProxyPort,
      } : { enabled: false, mode: 'remote-direct' },
    };
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

  handleHarnessStdout(instance, chunk) {
    const text = `${instance.stdoutBuffer || ''}${String(chunk)}`;
    const lines = text.split(/\r?\n/u);
    instance.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!this.consumeUsageLine(instance, line)) this.appendLog(instance, `${line}\n`);
    }
  }

  flushHarnessStdout(instance) {
    const line = instance.stdoutBuffer || '';
    instance.stdoutBuffer = '';
    if (line && !this.consumeUsageLine(instance, line)) this.appendLog(instance, line);
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
      createdAt: new Date().toISOString(),
      network: { enabled: false, mode: 'remote-direct' },
    };
    this.instances.set(instance.id, instance);

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
      this.appendLog(instance, '[launcher] Session environment and usage observer plugins deployed.\n');

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
        instance.error = error.message;
        instance.status = 'error';
        this.appendLog(instance, `[launcher] SSH process error: ${error.message}\n`);
      });
      child.once('exit', (code, signal) => {
        this.flushHarnessStdout(instance);
        if (instance.status === 'stopping' || instance.status === 'stopped') return;
        instance.status = code === 0 ? 'stopped' : 'error';
        if (code !== 0) instance.error = `SSH/Harness exited with code ${code}${signal ? ` (${signal})` : ''}.`;
        this.appendLog(instance, `[launcher] SSH/Harness exited${code !== null ? ` code=${code}` : ''}${signal ? ` signal=${signal}` : ''}.\n`);
      });

      await waitForHttp(localPort, { child, timeoutMs: 180000 });
      instance.status = 'running';
      this.appendLog(instance, `[launcher] Harness ready: http://127.0.0.1:${localPort}\n`);
      this.appendLog(instance, '[usage] Event-driven DeepSeek token/cost tracking is active; no /user/balance polling is used.\n');
      this.appendLog(instance, '[launcher] Each Harness session will ask for its Python/Conda environment on first Bash use. Use /env to change it later.\n');
      return this.publicInstance(instance);
    } catch (error) {
      instance.status = 'error';
      instance.error = error instanceof Error ? error.message : String(error);
      this.appendLog(instance, `[launcher] ERROR: ${instance.error}\n`);
      if (instance.child?.exitCode === null) instance.child.kill('SIGTERM');
      if (instance.network?.child?.exitCode === null) instance.network.child.kill('SIGTERM');
      if (instance.network?.enabled) await clearRemoteProxyEnvironment(instance.host, instance.id).catch(() => undefined);
      throw Object.assign(new Error(instance.error), { instanceId: instance.id });
    }
  }

  async stop(id) {
    const instance = this.instances.get(id);
    if (!instance) return false;
    instance.status = 'stopping';
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
    const proxyChild = instance.network?.child;
    if (proxyChild && proxyChild.exitCode === null) proxyChild.kill('SIGTERM');
    if (instance.network?.enabled) await clearRemoteProxyEnvironment(instance.host, instance.id).catch(() => undefined);
    instance.status = 'stopped';
    this.appendLog(instance, '[launcher] Stopped.\n');
    return true;
  }

  async stopAll() {
    await Promise.all([...this.instances.keys()].map((id) => this.stop(id)));
  }
}
