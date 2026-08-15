import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, copyFile, stat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { HarnessManager } from './manager.mjs';
import { findLocalFreePort, waitForHttp } from './ssh.mjs';

const MIN_LOCAL_NODE = [22, 19, 0];
const TERMINAL_STATUSES = new Set(['stopped', 'error']);

function versionTuple(value) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/u.exec(String(value || ''));
  return match ? match.slice(1, 4).map(Number) : [0, 0, 0];
}

function versionAtLeast(value, minimum = MIN_LOCAL_NODE) {
  const current = versionTuple(value);
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

function execText(file, args = [], timeout = 5000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout) => {
      resolve(error ? '' : String(stdout || '').trim());
    });
  });
}

function shellText(command, timeout = 5000) {
  if (process.platform !== 'win32') {
    const [file, ...args] = command.split(' ');
    return execText(file, args, timeout);
  }
  return execText(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], timeout);
}

async function commandPath(command) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const output = await execText(finder, [command], 3000);
  return output.split(/\r?\n/u).find(Boolean) || '';
}

export async function checkLocalRuntime() {
  const [nodePath, npxPath, node, npm, python, conda] = await Promise.all([
    commandPath('node'),
    commandPath('npx'),
    execText('node', ['--version']),
    process.platform === 'win32' ? shellText('npm --version') : execText('npm', ['--version']),
    execText(process.platform === 'win32' ? 'python.exe' : 'python3', ['--version']),
    process.platform === 'win32' ? shellText('conda --version') : execText('conda', ['--version']),
  ]);
  return {
    hostname: 'Local',
    os: process.platform,
    arch: process.arch,
    node: node || 'not found',
    npm: npm || 'not found',
    python: python || 'not found',
    conda: conda || 'not found',
    nodePath,
    npxPath,
    ready: Boolean(nodePath && npxPath && versionAtLeast(node)),
    minNode: MIN_LOCAL_NODE.join('.'),
  };
}

export async function listLocalDirectories(input) {
  const requested = String(input || '').trim();
  const resolved = path.resolve(requested || homedir());
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`Local directory does not exist: ${resolved}`);
  const entries = await readdir(resolved, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    current: resolved,
    parent: path.dirname(resolved) || resolved,
    directories,
  };
}

async function deployLocalTelemetryPlugin(pluginDirectory) {
  const dshHome = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh');
  const packageDirectory = path.join(dshHome, 'profiles', 'node_modules', 'deepseek-harness-remote-usage-cost');
  await mkdir(packageDirectory, { recursive: true });
  await copyFile(path.join(pluginDirectory, 'usage-cost.js'), path.join(packageDirectory, 'index.js'));
  await copyFile(path.join(pluginDirectory, 'usage-package.json'), path.join(packageDirectory, 'package.json'));
  return dshHome;
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.unref();
  } else {
    child.kill('SIGTERM');
  }
}

export class LocalHarnessManager extends HarnessManager {
  publicInstance(instance) {
    return {
      ...super.publicInstance(instance),
      mode: 'local',
      host: 'Local',
      remotePort: undefined,
    };
  }

  async launch({ workspace: workspaceInput }) {
    const workspace = path.resolve(String(workspaceInput || '').trim() || homedir());
    const workspaceInfo = await stat(workspace).catch(() => undefined);
    if (!workspaceInfo?.isDirectory()) throw new Error(`Local workspace does not exist: ${workspace}`);

    const runtime = await checkLocalRuntime();
    if (!runtime.ready) {
      throw new Error(`Local Node.js ${runtime.node} is unavailable or too old. Install Node.js >= ${runtime.minNode} with npm/npx and retry.`);
    }

    const instance = {
      id: randomUUID(),
      host: 'Local',
      mode: 'local',
      workspace,
      status: 'preparing',
      logs: '',
      stdoutBuffer: '',
      usageSessions: new Map(),
      latestUsageSessionId: undefined,
      balanceSnapshot: undefined,
      createdAt: new Date().toISOString(),
      network: { enabled: false, mode: 'local' },
      nodeVersion: runtime.node,
      nodeSource: 'local',
    };
    this.instances.set(instance.id, instance);
    this.emitInstanceStatus(instance);

    try {
      this.appendLog(instance, `[local] workspace=${workspace}\n`);
      this.appendLog(instance, `[local] node=${runtime.node} · ${runtime.nodePath}\n`);
      const dshHome = await deployLocalTelemetryPlugin(this.pluginDirectory);
      const localPort = await findLocalFreePort();
      const patchPath = path.join(this.pluginDirectory, 'cordis.local.patch.yml');
      instance.localPort = localPort;
      instance.status = 'starting';
      this.emitInstanceStatus(instance);

      const npx = runtime.npxPath || 'npx';
      const child = spawn(npx, [
        '--yes', '@deepseek-ai/dsh', '--profile', 'web', '--patch', patchPath, '--port', String(localPort),
      ], {
        cwd: workspace,
        env: { ...process.env, DSH_HOME: dshHome },
        windowsHide: true,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      instance.child = child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.handleHarnessStdout(instance, chunk));
      child.stderr.on('data', (chunk) => this.appendLog(instance, String(chunk)));
      child.once('error', (error) => {
        if (TERMINAL_STATUSES.has(instance.status)) return;
        this.appendLog(instance, `[local] process error: ${error.message}\n`);
        this.markEnded(instance, 'error', { error: `Local Harness process error: ${error.message}` });
      });
      child.once('exit', (code, signal) => {
        this.flushHarnessStdout(instance);
        if (instance.status === 'stopping' || instance.status === 'stopped') return;
        const status = code === 0 ? 'stopped' : 'error';
        this.markEnded(instance, status, {
          code,
          signal,
          error: code === 0 ? undefined : `Local Harness exited with code ${code ?? 'unknown'}.`,
        });
      });

      await waitForHttp(localPort, { child, timeoutMs: 180000 });
      if (child.exitCode !== null || TERMINAL_STATUSES.has(instance.status)) {
        throw new Error(instance.error || 'Local Harness exited before becoming ready.');
      }
      instance.status = 'running';
      this.emitInstanceStatus(instance);
      this.appendLog(instance, `[local] Harness ready: http://127.0.0.1:${localPort}\n`);
      this.appendLog(instance, '[usage] Session cost and account balance telemetry are active. Balance HTTP queries do not consume model tokens.\n');
      return this.publicInstance(instance);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!TERMINAL_STATUSES.has(instance.status)) this.markEnded(instance, 'error', { error: message });
      if (instance.child?.exitCode === null) killProcessTree(instance.child);
      this.appendLog(instance, `[local] ERROR: ${message}\n`);
      throw Object.assign(new Error(message), { instanceId: instance.id });
    }
  }

  async stop(id) {
    const instance = this.instances.get(id);
    if (!instance) return false;
    if (instance.status === 'stopped') return true;
    instance.status = 'stopping';
    this.emitInstanceStatus(instance);
    const child = instance.child;
    if (child?.exitCode === null) {
      killProcessTree(child);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    this.flushHarnessStdout(instance);
    this.markEnded(instance, 'stopped', { code: child?.exitCode, signal: child?.signalCode });
    this.appendLog(instance, '[local] Stopped.\n');
    return true;
  }
}
