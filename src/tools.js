import { defineTool } from '@deepseek-ai/dsh-tools';

function text(value) {
  return [{ type: 'text', text: String(value) }];
}

function renderExec(result) {
  const marker = result.timedOut
    ? '[timed out]'
    : `[exit code: ${result.exitCode ?? 'null'}]`;
  const parts = [marker];
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  if (result.error) parts.push(`error: ${result.error}`);
  parts.push(`duration: ${result.durationMs} ms`);
  return parts.join('\n');
}

function hostSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      alias: { type: 'string', required: true },
      hostname: { type: 'string', required: true },
      user: { type: 'string', required: true },
      port: { type: 'integer', required: true },
      identityFiles: { type: 'array', items: { type: 'string' }, required: true },
      proxyJump: { type: 'string' },
      proxyCommand: { type: 'string' },
      vpnRemoteForward: {
        type: 'object',
        additionalProperties: false,
        properties: {
          listenHost: { type: 'string', required: true },
          listenPort: { type: 'integer', required: true },
          targetHost: { type: 'string', required: true },
          targetPort: { type: 'integer', required: true },
        },
      },
      error: { type: 'string' },
    },
  };
}

export function openSshListTool(engine) {
  return defineTool({
    name: 'openssh_list',
    description: 'List SSH aliases discovered from the Windows account\'s ~/.ssh/config. Resolution uses the real system `ssh -G`, so Include/Match/ProxyJump/IdentityFile semantics remain OpenSSH-native. Use openssh_exec with an alias.',
    parameters: {
      query: { type: 'string', description: 'Optional alias substring filter.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hosts: { type: 'array', items: hostSchema(), required: true },
        },
      },
      render: (_args, value) => {
        const hosts = value.hosts || [];
        if (hosts.length === 0) return text('no concrete SSH aliases found');
        return text(hosts.map((host) => {
          const target = host.hostname ? `${host.user ? `${host.user}@` : ''}${host.hostname}:${host.port}` : 'unresolved';
          const vpn = host.vpnRemoteForward
            ? ` vpn=127.0.0.1:${host.vpnRemoteForward.listenPort}->${host.vpnRemoteForward.targetHost}:${host.vpnRemoteForward.targetPort}`
            : '';
          return `${host.alias} -> ${target}${vpn}${host.error ? ` error=${host.error}` : ''}`;
        }).join('\n'));
      },
    },
    async execute(args) {
      return { hosts: await engine.list(args.query) };
    },
  });
}

export function openSshExecTool(engine) {
  return defineTool({
    name: 'openssh_exec',
    description: 'Execute a command through the same system OpenSSH client as `ssh <alias>`. Ordinary exec uses ClearAllForwardings=yes to avoid fighting VS Code for configured RemoteForward ports. GitHub traffic automatically uses remote direct access when healthy, otherwise the Windows VPN bridge.',
    parameters: {
      alias: { type: 'string', required: true, description: 'OpenSSH Host alias or target.' },
      command: { type: 'string', required: true, description: 'Remote shell command.' },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds; default 60000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          timedOut: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(renderExec(value)),
    },
    async execute(args) {
      try {
        return await engine.exec(args.alias, args.command, args.timeoutMs);
      } catch (error) {
        return {
          success: false,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          durationMs: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

export function openSshProxyStatusTool(engine) {
  return defineTool({
    name: 'openssh_proxy_status',
    description: 'Inspect or refresh the SSH/VPN route for one alias. Reports whether GitHub is remote-direct, reusing an existing OpenSSH RemoteForward (such as VS Code 35052->Windows 7890), or using a Harness-managed fallback reverse tunnel.',
    parameters: {
      alias: { type: 'string', required: true, description: 'OpenSSH Host alias or target.' },
      refresh: { type: 'boolean', description: 'Re-probe the route now; default true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alias: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          localProxy: { type: 'string', required: true },
          route: { type: 'string', required: true },
          source: { type: 'string' },
          remotePort: { type: 'integer' },
          directOk: { type: 'boolean' },
          localProxyOk: { type: 'boolean' },
          localProxyDetail: { type: 'string' },
          hostname: { type: 'string', required: true },
          user: { type: 'string', required: true },
          port: { type: 'integer', required: true },
          configuredRemotePort: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text([
        `${value.alias} -> ${value.user ? `${value.user}@` : ''}${value.hostname}:${value.port}`,
        `mode=${value.mode} route=${value.route}${value.source ? ` source=${value.source}` : ''}`,
        `localProxy=${value.localProxy} localProxyOk=${String(value.localProxyOk ?? 'unknown')}${value.localProxyDetail ? ` (${value.localProxyDetail})` : ''}`,
        `configuredRemotePort=${value.configuredRemotePort ?? 'none'}${value.remotePort ? ` activeRemoteProxy=127.0.0.1:${value.remotePort}` : ''}`,
        value.error ? `error=${value.error}` : '',
      ].filter(Boolean).join('\n')),
    },
    async execute(args) {
      try {
        const status = await engine.proxyStatus(args.alias, { refresh: args.refresh !== false });
        return {
          alias: status.alias,
          mode: status.mode,
          localProxy: status.localProxy,
          route: status.route,
          ...(status.source ? { source: status.source } : {}),
          ...(status.remotePort ? { remotePort: status.remotePort } : {}),
          ...(typeof status.directOk === 'boolean' ? { directOk: status.directOk } : {}),
          ...(typeof status.localProxyOk === 'boolean' ? { localProxyOk: status.localProxyOk } : {}),
          ...(status.localProxyDetail ? { localProxyDetail: status.localProxyDetail } : {}),
          hostname: status.resolved.hostname,
          user: status.resolved.user,
          port: status.resolved.port,
          ...(status.resolved.vpnRemoteForward ? { configuredRemotePort: status.resolved.vpnRemoteForward.listenPort } : {}),
          ...(status.error ? { error: status.error } : {}),
        };
      } catch (error) {
        return {
          alias: args.alias,
          mode: 'unknown',
          localProxy: 'unknown',
          route: 'unavailable',
          hostname: '',
          user: '',
          port: 22,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

export function openSshUploadTool(engine) {
  return defineTool({
    name: 'openssh_upload',
    description: 'Upload one local file with the system scp client, reusing the same OpenSSH alias/configuration as Windows `ssh`.',
    parameters: {
      alias: { type: 'string', required: true },
      localPath: { type: 'string', required: true },
      remotePath: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          bytes: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.ok ? `uploaded ${value.bytes ?? 0} bytes` : `upload failed: ${value.error || 'unknown error'}`),
    },
    async execute(args) {
      try {
        return await engine.upload(args.alias, args.localPath, args.remotePath);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}

export function openSshDownloadTool(engine) {
  return defineTool({
    name: 'openssh_download',
    description: 'Download one remote file with the system scp client, reusing the same OpenSSH alias/configuration as Windows `ssh`.',
    parameters: {
      alias: { type: 'string', required: true },
      remotePath: { type: 'string', required: true },
      localPath: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          bytes: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.ok ? `downloaded ${value.bytes ?? 0} bytes` : `download failed: ${value.error || 'unknown error'}`),
    },
    async execute(args) {
      try {
        return await engine.download(args.alias, args.remotePath, args.localPath);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}

export function allOpenSshTools(engine) {
  return [
    openSshListTool(engine),
    openSshExecTool(engine),
    openSshProxyStatusTool(engine),
    openSshUploadTool(engine),
    openSshDownloadTool(engine),
  ];
}
