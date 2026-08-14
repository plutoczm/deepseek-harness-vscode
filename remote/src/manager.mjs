import { randomUUID } from 'node:crypto';
import {
  createHarnessTunnel,
  deployPlugin,
  findLocalFreePort,
  findRemoteFreePort,
  resolveRemoteNode,
  waitForHttp,
} from './ssh.mjs';
import { validateHost, validateRemotePath } from './config.mjs';

const MAX_LOG_CHARS = 250_000;

export class HarnessManager {
  constructor(pluginDirectory) {
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

  appendLog(instance, chunk) {
    instance.logs += chunk;
    if (instance.logs.length > MAX_LOG_CHARS) instance.logs = instance.logs.slice(-MAX_LOG_CHARS);
  }

  async launch({ host: hostInput, workspace: workspaceInput, installRuntime = true }) {
    const host = validateHost(hostInput);
    const workspace = validateRemotePath(workspaceInput);
    const instance = {
      id: randomUUID(),
      host,
      workspace,
      status: 'preparing',
      logs: '',
      createdAt: new Date().toISOString(),
    };
    this.instances.set(instance.id, instance);

    try {
      this.appendLog(instance, `[launcher] Connecting to ${host}\n`);
      const runtime = await resolveRemoteNode(host, { installIfMissing: installRuntime });
      if (!runtime.path && runtime.source === 'missing') {
        throw new Error(`Remote Node.js is ${runtime.version || 'unavailable'}. DeepSeek Harness requires Node.js >= 22.19.0. Install the private runtime and retry.`);
      }
      instance.nodeVersion = runtime.version;
      instance.nodeSource = runtime.source;
      this.appendLog(instance, `[launcher] Node ${runtime.version} (${runtime.source})\n`);
      if (runtime.condaPath) this.appendLog(instance, `[launcher] Conda ${runtime.condaPath}\n`);

      await deployPlugin(host, this.pluginDirectory);
      this.appendLog(instance, '[launcher] Session environment plugin deployed.\n');

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
        onLog: (chunk) => this.appendLog(instance, chunk),
      });
      instance.child = child;
      child.once('error', (error) => {
        instance.error = error.message;
        instance.status = 'error';
        this.appendLog(instance, `[launcher] SSH process error: ${error.message}\n`);
      });
      child.once('exit', (code, signal) => {
        if (instance.status === 'stopping' || instance.status === 'stopped') return;
        instance.status = code === 0 ? 'stopped' : 'error';
        if (code !== 0) instance.error = `SSH/Harness exited with code ${code}${signal ? ` (${signal})` : ''}.`;
        this.appendLog(instance, `[launcher] SSH/Harness exited${code !== null ? ` code=${code}` : ''}${signal ? ` signal=${signal}` : ''}.\n`);
      });

      await waitForHttp(localPort, { child, timeoutMs: 180000 });
      instance.status = 'running';
      this.appendLog(instance, `[launcher] Harness ready: http://127.0.0.1:${localPort}\n`);
      this.appendLog(instance, '[launcher] Each Harness session will ask for its Python/Conda environment on first Bash use. Use /env to change it later.\n');
      return this.publicInstance(instance);
    } catch (error) {
      instance.status = 'error';
      instance.error = error instanceof Error ? error.message : String(error);
      this.appendLog(instance, `[launcher] ERROR: ${instance.error}\n`);
      if (instance.child?.exitCode === null) instance.child.kill('SIGTERM');
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
    instance.status = 'stopped';
    this.appendLog(instance, '[launcher] Stopped.\n');
    return true;
  }

  async stopAll() {
    await Promise.all([...this.instances.keys()].map((id) => this.stop(id)));
  }
}
