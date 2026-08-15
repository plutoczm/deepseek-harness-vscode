import { spawn } from 'node:child_process';
import { parseOpenSshConfig, shellQuote } from './util.js';

function assertSshTarget(alias) {
  const value = String(alias || '').trim();
  if (!value || value.startsWith('-') || /\s/u.test(value) || /[\r\n\0]/u.test(value)) {
    throw new Error(`invalid SSH alias/target: ${JSON.stringify(alias)}`);
  }
  return value;
}

export function processResult(command, args, {
  timeoutMs = 30_000,
  maxBytes = 32 * 1024 * 1024,
  input,
  env,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...extra,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr,
      });
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, signal: undefined, timedOut: true, error: `timeout after ${timeoutMs} ms` });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        child.kill();
        finish({ code: null, signal: undefined, timedOut: false, error: `output exceeded ${maxBytes} bytes` });
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-256 * 1024); });
    child.once('error', (error) => finish({ code: null, signal: undefined, timedOut: false, error: error.message }));
    child.once('close', (code, signal) => finish({ code, signal, timedOut: false }));

    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

function baseOptions({ clearForwardings = true, terminal = false, batchMode = true } = {}) {
  const args = [];
  if (batchMode) args.push('-o', 'BatchMode=yes');
  args.push(
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
  );
  if (clearForwardings) args.push('-o', 'ClearAllForwardings=yes');
  args.push(terminal ? '-tt' : '-T');
  return args;
}

/** Ordinary operations must never recreate RemoteForward entries from ~/.ssh/config. */
export function buildSshExecArgs(alias, { terminal = false, batchMode = true } = {}) {
  const target = assertSshTarget(alias);
  return [...baseOptions({ clearForwardings: true, terminal, batchMode }), target];
}

/** A tunnel owner intentionally keeps configured forwards enabled and must fail if they cannot bind. */
export function buildConfiguredTunnelArgs(alias) {
  const target = assertSshTarget(alias);
  return [
    ...baseOptions({ clearForwardings: false, terminal: false, batchMode: true }),
    '-o', 'ExitOnForwardFailure=yes',
    '-N',
    target,
  ];
}

/**
 * Explicit fallback tunnel. We keep OpenSSH's effective config authoritative,
 * including any unrelated user forwards, but make forward setup fail-loud so a
 * process can never look healthy while the requested reverse tunnel is absent.
 */
export function buildExplicitTunnelArgs(alias, remotePort, localHost, localPort) {
  const target = assertSshTarget(alias);
  const reverse = `127.0.0.1:${Number(remotePort)}:${localHost}:${Number(localPort)}`;
  return [
    ...baseOptions({ clearForwardings: false, terminal: false, batchMode: true }),
    '-o', 'ExitOnForwardFailure=yes',
    '-N',
    '-R', reverse,
    target,
  ];
}

export async function resolveOpenSshConfig(alias, timeoutMs = 8_000) {
  const target = assertSshTarget(alias);
  const result = await processResult('ssh', ['-G', target], { timeoutMs, maxBytes: 2 * 1024 * 1024 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.error || `ssh -G ${target} failed`);
  }
  return parseOpenSshConfig(result.stdout, target);
}

export async function runRemoteCommand(alias, command, {
  timeoutMs = 60_000,
  maxBytes = 4 * 1024 * 1024,
} = {}) {
  const started = Date.now();
  const remoteCommand = `sh -lc ${shellQuote(command)}`;
  const result = await processResult('ssh', [...buildSshExecArgs(alias), remoteCommand], { timeoutMs, maxBytes });
  return {
    success: result.code === 0,
    exitCode: result.code,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - started,
    ...(result.error ? { error: result.error } : {}),
  };
}

/** Cheap authenticated baseline check before any managed tunnel is spawned. */
export async function probeSshBaseline(alias, timeoutMs = 8_000) {
  const result = await runRemoteCommand(alias, 'true', {
    timeoutMs: timeoutMs + 2_000,
    maxBytes: 128 * 1024,
  });
  return { ok: result.success, ...result };
}

/**
 * Probe SSH transport, remote-direct GitHub and an optional reverse-proxy port
 * inside ONE authenticated SSH session. This matters on Windows corporate VPN
 * stacks (notably aTrust VNIC), where several back-to-back new SSH handshakes
 * can be reset during banner/KEX even though a standalone ssh command works.
 *
 * The remote script always exits 0 after it starts, so exitCode=0 proves the SSH
 * baseline independently from whether GitHub/direct/proxy connectivity works.
 */
export async function probeRemoteRoute(alias, {
  includeDirect = true,
  proxyPort,
  timeoutMs = 8_000,
} = {}) {
  const proxy = Number(proxyPort) > 0 ? `http://127.0.0.1:${Number(proxyPort)}` : '';
  const lines = [
    'dsh_probe_url() {',
    '  dsh_proxy="$1"',
    '  if command -v curl >/dev/null 2>&1; then',
    '    if [ -n "$dsh_proxy" ]; then',
    '      curl -fsSI -x "$dsh_proxy" --connect-timeout 5 --max-time 8 https://github.com >/dev/null 2>&1',
    '    else',
    '      curl -fsSI --noproxy "*" --connect-timeout 5 --max-time 8 https://github.com >/dev/null 2>&1',
    '    fi',
    '  elif command -v git >/dev/null 2>&1; then',
    '    if [ -n "$dsh_proxy" ]; then',
    '      HTTPS_PROXY="$dsh_proxy" HTTP_PROXY="$dsh_proxy" ALL_PROXY="$dsh_proxy" https_proxy="$dsh_proxy" http_proxy="$dsh_proxy" all_proxy="$dsh_proxy" GIT_TERMINAL_PROMPT=0 git -c http.proxy="$dsh_proxy" ls-remote https://github.com/git/git.git HEAD >/dev/null 2>&1',
    '    else',
    '      HTTPS_PROXY= HTTP_PROXY= ALL_PROXY= https_proxy= http_proxy= all_proxy= GIT_TERMINAL_PROMPT=0 git -c http.proxy= ls-remote https://github.com/git/git.git HEAD >/dev/null 2>&1',
    '    fi',
    '  else',
    '    return 127',
    '  fi',
    '}',
  ];

  if (includeDirect) {
    lines.push("if dsh_probe_url ''; then printf 'DSH_DIRECT=1\\n'; else printf 'DSH_DIRECT=0\\n'; fi");
  } else {
    lines.push("printf 'DSH_DIRECT=SKIP\\n'");
  }
  if (proxy) {
    lines.push(`if dsh_probe_url ${shellQuote(proxy)}; then printf 'DSH_PROXY=1\\n'; else printf 'DSH_PROXY=0\\n'; fi`);
  } else {
    lines.push("printf 'DSH_PROXY=SKIP\\n'");
  }
  lines.push("printf 'DSH_SSH=1\\n'", 'exit 0');

  const result = await runRemoteCommand(alias, lines.join('\n'), {
    timeoutMs: timeoutMs + 12_000,
    maxBytes: 256 * 1024,
  });
  const sshOk = result.success && /(?:^|\n)DSH_SSH=1(?:\n|$)/u.test(result.stdout);
  return {
    ok: sshOk,
    sshOk,
    directOk: sshOk && /(?:^|\n)DSH_DIRECT=1(?:\n|$)/u.test(result.stdout),
    proxyOk: sshOk && /(?:^|\n)DSH_PROXY=1(?:\n|$)/u.test(result.stdout),
    ...result,
  };
}

export async function probeRemoteGitHub(alias, timeoutMs = 8_000) {
  const script = [
    'if command -v curl >/dev/null 2>&1; then',
    '  curl -fsSI --connect-timeout 5 --max-time 8 https://github.com >/dev/null',
    'elif command -v git >/dev/null 2>&1; then',
    '  GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/git/git.git HEAD >/dev/null 2>&1',
    'else',
    '  exit 127',
    'fi',
  ].join('\n');
  const result = await runRemoteCommand(alias, script, { timeoutMs: timeoutMs + 4_000, maxBytes: 256 * 1024 });
  return { ok: result.success, ...result };
}

export async function probeRemoteProxy(alias, remotePort, timeoutMs = 8_000) {
  const proxy = `http://127.0.0.1:${Number(remotePort)}`;
  const script = [
    'if command -v curl >/dev/null 2>&1; then',
    `  curl -fsSI -x ${proxy} --connect-timeout 5 --max-time 8 https://github.com >/dev/null`,
    'elif command -v git >/dev/null 2>&1; then',
    `  HTTPS_PROXY=${proxy} HTTP_PROXY=${proxy} GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/git/git.git HEAD >/dev/null 2>&1`,
    'else',
    '  exit 127',
    'fi',
  ].join('\n');
  const result = await runRemoteCommand(alias, script, { timeoutMs: timeoutMs + 4_000, maxBytes: 256 * 1024 });
  return { ok: result.success, ...result };
}

function spawnTunnel(args) {
  return spawn('ssh', args, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

export function startConfiguredTunnel(alias) {
  return spawnTunnel(buildConfiguredTunnelArgs(alias));
}

export function startExplicitTunnel(alias, remotePort, localHost, localPort) {
  return spawnTunnel(buildExplicitTunnelArgs(alias, remotePort, localHost, localPort));
}

export async function copyToRemote(alias, localPath, remotePath, timeoutMs = 120_000) {
  const target = assertSshTarget(alias);
  const result = await processResult('scp', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ClearAllForwardings=yes',
    String(localPath),
    `${target}:${String(remotePath)}`,
  ], { timeoutMs, maxBytes: 512 * 1024 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.error || 'scp upload failed');
  return result;
}

export async function copyFromRemote(alias, remotePath, localPath, timeoutMs = 120_000) {
  const target = assertSshTarget(alias);
  const result = await processResult('scp', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ClearAllForwardings=yes',
    `${target}:${String(remotePath)}`,
    String(localPath),
  ], { timeoutMs, maxBytes: 512 * 1024 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.error || 'scp download failed');
  return result;
}
