import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  copyFromRemote,
  copyToRemote,
  resolveOpenSshConfig,
  runRemoteCommand,
} from './openssh.js';
import {
  matchingProxyForward,
  parseConcreteHostAliases,
  prefixShellEnvironment,
} from './util.js';

function userSshConfigPath() {
  return join(homedir(), '.ssh', 'config');
}

export class OpenSshEngine {
  constructor(routes) {
    this.routes = routes;
  }

  discoverAliases() {
    const aliases = new Set(this.routes.config.extraAliases || []);
    const path = userSshConfigPath();
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      for (const alias of parseConcreteHostAliases(text)) aliases.add(alias);
    }
    for (const state of this.routes.snapshot()) aliases.add(state.alias);
    return [...aliases].sort((a, b) => a.localeCompare(b));
  }

  async describe(alias) {
    const resolved = await resolveOpenSshConfig(alias, this.routes.config.probeTimeoutMs);
    const forward = matchingProxyForward(resolved, this.routes.config);
    return {
      alias: resolved.alias,
      hostname: resolved.hostname,
      user: resolved.user,
      port: resolved.port,
      identityFiles: resolved.identityFiles,
      ...(resolved.proxyJump ? { proxyJump: resolved.proxyJump } : {}),
      ...(resolved.proxyCommand ? { proxyCommand: resolved.proxyCommand } : {}),
      ...(forward ? {
        vpnRemoteForward: {
          listenHost: forward.listenHost,
          listenPort: forward.listenPort,
          targetHost: forward.targetHost,
          targetPort: forward.targetPort,
        },
      } : {}),
    };
  }

  async list(query) {
    const needle = String(query || '').trim().toLowerCase();
    const aliases = this.discoverAliases()
      .filter((alias) => !needle || alias.toLowerCase().includes(needle));
    const rows = await Promise.all(aliases.map(async (alias) => {
      try {
        return await this.describe(alias);
      } catch (error) {
        return {
          alias,
          hostname: '',
          user: '',
          port: 22,
          identityFiles: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    return rows;
  }

  async exec(alias, command, timeoutMs) {
    await this.routes.ensure(alias);
    const environment = this.routes.proxyEnv(alias);
    const routedCommand = environment
      ? prefixShellEnvironment(command, environment)
      : command;
    return runRemoteCommand(alias, routedCommand, {
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 60_000,
    });
  }

  async test(alias) {
    const result = await runRemoteCommand(alias, 'printf DSH_OPENSSH_OK', { timeoutMs: 15_000, maxBytes: 256 * 1024 });
    return {
      ok: result.success && result.stdout.includes('DSH_OPENSSH_OK'),
      ...result,
    };
  }

  async proxyStatus(alias, { refresh = true } = {}) {
    if (refresh) await this.routes.ensure(alias, { force: true });
    const state = this.routes.snapshot(alias)[0];
    const resolved = await this.describe(alias);
    return {
      alias,
      mode: this.routes.mode,
      localProxy: `${this.routes.config.localProxyHost}:${this.routes.config.localProxyPort}`,
      route: state?.route || 'unchecked',
      source: state?.source,
      remotePort: state?.remotePort,
      directOk: state?.directOk,
      localProxyOk: state?.localProxyOk,
      error: state?.error,
      resolved,
    };
  }

  async upload(alias, localPath, remotePath) {
    if (!existsSync(localPath)) throw new Error(`local file does not exist: ${localPath}`);
    const before = statSync(localPath);
    if (!before.isFile()) throw new Error('upload currently supports files only');
    await copyToRemote(alias, localPath, remotePath);
    return { ok: true, bytes: before.size };
  }

  async download(alias, remotePath, localPath) {
    await copyFromRemote(alias, remotePath, localPath);
    const after = statSync(localPath);
    return { ok: true, bytes: after.size };
  }
}
