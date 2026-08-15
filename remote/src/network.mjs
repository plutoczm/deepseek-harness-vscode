import { spawn } from 'node:child_process';
import net from 'node:net';
import { findRemoteFreePort, runSsh } from './ssh.mjs';

const DEFAULT_PROXY_HOST = process.env.DSH_LOCAL_PROXY_HOST || '127.0.0.1';
const DEFAULT_PROXY_PORT = Number(process.env.DSH_LOCAL_PROXY_PORT || 7890);
const GITHUB_PROBE_PREFIX = '__DHR_GITHUB__';
const GITHUB_AUTH_PREFIX = '__DHR_GH_AUTH__';
const NETWORK_MODES = new Set(['auto', 'direct', 'local-proxy']);

function safeInstanceId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/gu, '_');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function boundedTimeout(value, fallback = 6500) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1500, Math.min(20_000, Math.round(number)));
}

function parseMarkerLines(text, prefix) {
  const result = {};
  for (const line of String(text || '').split(/\r?\n/u)) {
    if (!line.startsWith(prefix)) continue;
    const payload = line.slice(prefix.length);
    const index = payload.indexOf('=');
    if (index <= 0) continue;
    result[payload.slice(0, index)] = payload.slice(index + 1);
  }
  return result;
}

function pushReadiness(values) {
  if (values.skipped === '1') return { status: 'not-checked', reason: 'Workspace checks were skipped.' };
  if (values.isRepo !== '1') return { status: 'not-repository', reason: 'The selected workspace is not a Git repository.' };
  if (!values.origin) return { status: 'no-origin', reason: 'No origin remote is configured.' };
  if (values.brokenHelper === '1') return { status: 'credential-error', reason: 'A known-broken repository-local GitHub credential helper is configured.' };
  if (values.lsRemoteOk !== '1') {
    const failure = values.lsRemoteClass || 'unknown';
    if (failure === 'auth') return { status: 'auth-error', reason: 'The remote read test failed with an authentication/authorization error.' };
    if (failure === 'credential') return { status: 'credential-error', reason: 'The remote read test failed in the credential helper chain.' };
    if (failure === 'network') return { status: 'network-error', reason: 'The remote read test failed because GitHub was unreachable.' };
    if (failure === 'timeout') return { status: 'network-error', reason: 'The remote read test timed out.' };
    return { status: 'remote-error', reason: 'The remote read test failed for an unclassified reason.' };
  }
  if (values.remoteProtocol === 'https') {
    if (values.authenticated !== '1') {
      return {
        status: 'auth-warning',
        reason: 'GitHub can be read, but gh is not authenticated; public-repository reads can succeed anonymously while push still fails.',
      };
    }
    if (!String(values.helpers || '').includes('gh auth git-credential')) {
      return {
        status: 'credential-warning',
        reason: 'GitHub read and gh authentication succeeded, but the gh HTTPS credential helper was not detected.',
      };
    }
  }
  return {
    status: 'likely-ready',
    reason: 'Network, remote read, and detected credential prerequisites are healthy. Write permission is not mutated/tested by Network Doctor.',
  };
}

export function normalizeNetworkMode(value, legacyEnableLocalProxy = false) {
  const mode = String(value || '').trim().toLowerCase();
  if (NETWORK_MODES.has(mode)) return mode;
  return legacyEnableLocalProxy ? 'local-proxy' : 'auto';
}

export function probeLocalHttpProxy(host = DEFAULT_PROXY_HOST, port = DEFAULT_PROXY_PORT, timeoutMs = 3500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let data = '';
    let settled = false;
    const finish = (ok, detail = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok, host, port, protocol: ok ? 'http' : undefined, detail });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('error', (error) => finish(false, error.message));
    socket.once('connect', () => {
      socket.write('CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nProxy-Connection: keep-alive\r\n\r\n');
    });
    socket.on('data', (chunk) => {
      data += chunk;
      const firstLine = data.split(/\r?\n/u)[0] || '';
      if (/^HTTP\/1\.[01] 2\d\d\b/u.test(firstLine)) finish(true, firstLine);
      else if (/^HTTP\/1\.[01] \d{3}\b/u.test(firstLine)) finish(false, firstLine);
    });
  });
}

export async function probeRemoteGithub(host, runtimeBin = '', timeoutMs = 6500) {
  const timeout = boundedTimeout(timeoutMs);
  const pathPrefix = runtimeBin ? `export PATH=${shellQuote(runtimeBin)}:"$PATH"\n` : '';
  const nodeScript = `const https = require('node:https');\nconst started = Date.now();\nlet done = false;\nconst finish = (payload) => { if (done) return; done = true; console.log(${JSON.stringify(GITHUB_PROBE_PREFIX)} + JSON.stringify({ ...payload, latencyMs: Date.now() - started })); };\nconst request = https.request('https://github.com/', { method: 'HEAD', headers: { 'user-agent': 'DeepSeek-Harness-Desktop' } }, (response) => {\n  const status = Number(response.statusCode || 0);\n  finish({ ok: status >= 200 && status < 500, status });\n  response.resume();\n});\nrequest.setTimeout(${timeout}, () => request.destroy(new Error('timeout')));\nrequest.on('error', (error) => finish({ ok: false, error: error.message || String(error) }));\nrequest.end();\nsetTimeout(() => finish({ ok: false, error: 'timeout' }), ${timeout + 250}).unref?.();\n`;
  try {
    const { stdout } = await runSsh(host, `${pathPrefix}node - <<'NODE'\n${nodeScript}NODE\n`, {
      timeoutMs: timeout + 5000,
      maxBytes: 64 * 1024,
    });
    const line = stdout.split(/\r?\n/u).findLast((item) => item.startsWith(GITHUB_PROBE_PREFIX));
    if (!line) return { ok: false, error: 'GitHub probe returned no result.' };
    const parsed = JSON.parse(line.slice(GITHUB_PROBE_PREFIX.length));
    return {
      ok: Boolean(parsed.ok),
      status: Number.isFinite(Number(parsed.status)) ? Number(parsed.status) : undefined,
      latencyMs: Number.isFinite(Number(parsed.latencyMs)) ? Number(parsed.latencyMs) : undefined,
      error: parsed.error ? String(parsed.error) : undefined,
      route: 'remote-direct',
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      route: 'remote-direct',
    };
  }
}

export async function diagnoseRemoteGitHub(host, workspace = '') {
  const target = String(workspace || '').trim();
  const script = `set +e\nTARGET=${shellQuote(target)}\nGH_PATH="$(command -v gh 2>/dev/null)"\nGIT_PATH="$(command -v git 2>/dev/null)"\nGH_VERSION="$([ -n "$GH_PATH" ] && gh --version 2>/dev/null | head -n 1)"\nGIT_VERSION="$([ -n "$GIT_PATH" ] && git --version 2>/dev/null | head -n 1)"\nGH_AUTH=0\nGH_LOGIN=''\nSKIPPED=0\nDNS_OK=0\nDNS_ADDRESS=''\nif command -v getent >/dev/null 2>&1; then DNS_ADDRESS="$(getent ahostsv4 github.com 2>/dev/null | awk 'NR==1 {print $1}')"; fi\nif [ -z "$DNS_ADDRESS" ] && command -v python3 >/dev/null 2>&1; then DNS_ADDRESS="$(python3 -c 'import socket; print(socket.gethostbyname("github.com"))' 2>/dev/null)"; fi\nif [ -n "$DNS_ADDRESS" ]; then DNS_OK=1; fi\nif [ -z "$TARGET" ]; then SKIPPED=1; fi\nif [ -n "$TARGET" ] && [ -n "$GH_PATH" ] && gh auth status --hostname github.com >/dev/null 2>&1; then\n  GH_AUTH=1\n  GH_LOGIN="$(gh api user --jq .login 2>/dev/null | head -n 1)"\nfi\nIS_REPO=0\nORIGIN=''\nREMOTE_PROTOCOL=''\nHELPERS=''\nLOCAL_HELPERS=''\nBROKEN_HELPER=0\nLS_REMOTE_OK=0\nLS_REMOTE_CLASS='skipped'\nif [ -n "$GIT_PATH" ] && [ -n "$TARGET" ] && git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1; then\n  IS_REPO=1\n  ORIGIN="$(git -C "$TARGET" remote get-url origin 2>/dev/null | head -n 1)"\n  case "$ORIGIN" in\n    https://github.com/*) REMOTE_PROTOCOL='https' ;;\n    git@github.com:*|ssh://git@github.com/*) REMOTE_PROTOCOL='ssh' ;;\n    *) REMOTE_PROTOCOL='other' ;;\n  esac\n  HELPERS="$( { git -C "$TARGET" config --show-origin --get-all credential.https://github.com.helper 2>/dev/null; git -C "$TARGET" config --show-origin --get-all credential.helper 2>/dev/null; } | tr '\\n' '|' )"\n  LOCAL_HELPERS="$( { git -C "$TARGET" config --local --get-all credential.https://github.com.helper 2>/dev/null; git -C "$TARGET" config --local --get-all credential.helper 2>/dev/null; } | tr '\\n' '|' )"\n  if printf '%s' "$LOCAL_HELPERS" | grep -Fq 'gh auth git-credential ""'; then BROKEN_HELPER=1; fi\n  if [ -n "$ORIGIN" ]; then\n    ERR_FILE="$(mktemp)"\n    if command -v timeout >/dev/null 2>&1; then\n      timeout 12s git -C "$TARGET" ls-remote --exit-code origin HEAD >/dev/null 2>"$ERR_FILE"\n      LS_CODE=$?\n    else\n      git -C "$TARGET" ls-remote --exit-code origin HEAD >/dev/null 2>"$ERR_FILE"\n      LS_CODE=$?\n    fi\n    if [ "$LS_CODE" -eq 0 ]; then\n      LS_REMOTE_OK=1\n      LS_REMOTE_CLASS='ok'\n    elif [ "$LS_CODE" -eq 124 ]; then\n      LS_REMOTE_CLASS='timeout'\n    elif grep -Eqi 'authentication failed|could not read Username|403|permission denied|repository not found|authentication required' "$ERR_FILE"; then\n      LS_REMOTE_CLASS='auth'\n    elif grep -Eqi 'operation not supported|credential' "$ERR_FILE"; then\n      LS_REMOTE_CLASS='credential'\n    elif grep -Eqi 'could not resolve|failed to connect|timed out|timeout|connection reset|network is unreachable|could not connect|connection refused' "$ERR_FILE"; then\n      LS_REMOTE_CLASS='network'\n    else\n      LS_REMOTE_CLASS='other'\n    fi\n    rm -f "$ERR_FILE"\n  fi\nfi\nprintf '${GITHUB_AUTH_PREFIX}skipped=%s\\n' "$SKIPPED"\nprintf '${GITHUB_AUTH_PREFIX}dnsOk=%s\\n' "$DNS_OK"\nprintf '${GITHUB_AUTH_PREFIX}dnsAddress=%s\\n' "$DNS_ADDRESS"\nprintf '${GITHUB_AUTH_PREFIX}ghPath=%s\\n' "$GH_PATH"\nprintf '${GITHUB_AUTH_PREFIX}ghVersion=%s\\n' "$GH_VERSION"\nprintf '${GITHUB_AUTH_PREFIX}gitPath=%s\\n' "$GIT_PATH"\nprintf '${GITHUB_AUTH_PREFIX}gitVersion=%s\\n' "$GIT_VERSION"\nprintf '${GITHUB_AUTH_PREFIX}authenticated=%s\\n' "$GH_AUTH"\nprintf '${GITHUB_AUTH_PREFIX}login=%s\\n' "$GH_LOGIN"\nprintf '${GITHUB_AUTH_PREFIX}isRepo=%s\\n' "$IS_REPO"\nprintf '${GITHUB_AUTH_PREFIX}origin=%s\\n' "$ORIGIN"\nprintf '${GITHUB_AUTH_PREFIX}remoteProtocol=%s\\n' "$REMOTE_PROTOCOL"\nprintf '${GITHUB_AUTH_PREFIX}helpers=%s\\n' "$HELPERS"\nprintf '${GITHUB_AUTH_PREFIX}brokenHelper=%s\\n' "$BROKEN_HELPER"\nprintf '${GITHUB_AUTH_PREFIX}lsRemoteOk=%s\\n' "$LS_REMOTE_OK"\nprintf '${GITHUB_AUTH_PREFIX}lsRemoteClass=%s\\n' "$LS_REMOTE_CLASS"\nexit 0\n`;
  try {
    const { stdout } = await runSsh(host, script, { timeoutMs: 30_000, maxBytes: 128 * 1024 });
    const values = parseMarkerLines(stdout, GITHUB_AUTH_PREFIX);
    return {
      skipped: values.skipped === '1',
      dns: {
        ok: values.dnsOk === '1',
        address: values.dnsAddress || undefined,
      },
      ghAvailable: Boolean(values.ghPath),
      ghVersion: values.ghVersion || undefined,
      gitAvailable: Boolean(values.gitPath),
      gitVersion: values.gitVersion || undefined,
      authenticated: values.authenticated === '1',
      login: values.login || undefined,
      isRepository: values.isRepo === '1',
      origin: values.origin || undefined,
      remoteProtocol: values.remoteProtocol || undefined,
      credentialHelpers: values.helpers ? values.helpers.split('|').filter(Boolean) : [],
      brokenCredentialHelper: values.brokenHelper === '1',
      lsRemote: {
        ok: values.lsRemoteOk === '1',
        classification: values.lsRemoteClass || 'unknown',
      },
      pushReadiness: pushReadiness(values),
      writePermissionTested: false,
    };
  } catch (error) {
    return {
      skipped: !target,
      dns: { ok: false },
      ghAvailable: false,
      gitAvailable: false,
      authenticated: false,
      isRepository: false,
      brokenCredentialHelper: false,
      lsRemote: { ok: false, classification: 'diagnostic-error' },
      pushReadiness: { status: 'diagnostic-error', reason: 'Remote GitHub diagnostics could not complete.' },
      writePermissionTested: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function repairRemoteGitCredential(host, workspace = '') {
  const target = String(workspace || '').trim();
  const script = `set -e\nTARGET=${shellQuote(target)}\ncommand -v gh >/dev/null 2>&1 || { echo 'GitHub CLI (gh) is not installed on the remote server.' >&2; exit 2; }\ngh auth status --hostname github.com >/dev/null 2>&1 || { echo 'GitHub CLI is not authenticated for github.com.' >&2; exit 3; }\nif [ -n "$TARGET" ] && git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1; then\n  LOCAL_GENERIC="$(git -C "$TARGET" config --local --get-all credential.helper 2>/dev/null || true)"\n  LOCAL_GITHUB="$(git -C "$TARGET" config --local --get-all credential.https://github.com.helper 2>/dev/null || true)"\n  if printf '%s\\n%s' "$LOCAL_GENERIC" "$LOCAL_GITHUB" | grep -Fq 'gh auth git-credential ""'; then\n    git -C "$TARGET" config --local --unset-all credential.helper '.*gh auth git-credential "".*' >/dev/null 2>&1 || true\n    git -C "$TARGET" config --local --unset-all credential.https://github.com.helper '.*gh auth git-credential "".*' >/dev/null 2>&1 || true\n  fi\nfi\ngh auth setup-git --hostname github.com\n`;
  await runSsh(host, script, { timeoutMs: 20_000, maxBytes: 128 * 1024 });
  return diagnoseRemoteGitHub(host, target);
}

async function writeRemoteProxyEnvironment(host, instanceId, proxyUrl) {
  const safeId = safeInstanceId(instanceId);
  const quotedProxy = shellQuote(proxyUrl);
  const script = `set -e\nROOT="\${DEEPSEEK_HARNESS_REMOTE_HOME:-$HOME/.deepseek-harness-remote}"\nDIR="$ROOT/session-env"\nmkdir -p "$DIR"\ncat > "$DIR/network-${safeId}.sh" <<'EOF'\n# Generated by DeepSeek Harness Remote. Bash/tool traffic only.\nexport HTTP_PROXY=${quotedProxy}\nexport HTTPS_PROXY=${quotedProxy}\nexport ALL_PROXY=${quotedProxy}\nexport http_proxy=${quotedProxy}\nexport https_proxy=${quotedProxy}\nexport all_proxy=${quotedProxy}\nexport NO_PROXY='api.deepseek.com,.deepseek.com,127.0.0.1,localhost,::1'\nexport no_proxy="$NO_PROXY"\nEOF\nchmod 600 "$DIR/network-${safeId}.sh"\n`;
  await runSsh(host, script, { timeoutMs: 15000 });
}

export async function clearRemoteProxyEnvironment(host, instanceId) {
  const safeId = safeInstanceId(instanceId);
  await runSsh(host, `ROOT="\${DEEPSEEK_HARNESS_REMOTE_HOME:-$HOME/.deepseek-harness-remote}"\nrm -f "$ROOT/session-env/network-${safeId}.sh"\n`, { timeoutMs: 10000 }).catch(() => undefined);
}

export async function startLocalProxyBridge({ host, instanceId, runtimeBin, onLog, localProxyHost = DEFAULT_PROXY_HOST, localProxyPort = DEFAULT_PROXY_PORT } = {}) {
  const probe = await probeLocalHttpProxy(localProxyHost, localProxyPort);
  if (!probe.ok) {
    onLog?.(`[network] Local proxy ${localProxyHost}:${localProxyPort} is unavailable (${probe.detail || 'probe failed'}); remote Bash traffic will use the server network directly.\n`);
    return { enabled: false, mode: 'remote-direct', localProxyHost, localProxyPort, proxyProbe: probe };
  }

  const remoteProxyPort = await findRemoteFreePort(host, runtimeBin);
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-T',
    '-N',
    '-o', 'ExitOnForwardFailure=no',
    '-R', `${remoteProxyPort}:${localProxyHost}:${localProxyPort}`,
    host,
  ];
  const child = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => onLog?.(`[network:ssh] ${String(chunk)}`));
  child.stderr?.on('data', (chunk) => onLog?.(`[network:ssh] ${String(chunk)}`));

  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, 900);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Proxy SSH bridge exited early with code ${code}.`));
    });
  });

  const proxyUrl = `http://127.0.0.1:${remoteProxyPort}`;
  await writeRemoteProxyEnvironment(host, instanceId, proxyUrl);
  onLog?.(`[network] Bash/Git/web traffic will use local proxy ${localProxyHost}:${localProxyPort} through SSH reverse port ${remoteProxyPort}.\n`);
  onLog?.('[network] DeepSeek model traffic is NOT given HTTP_PROXY/HTTPS_PROXY and remains on the remote server network.\n');
  return {
    enabled: true,
    mode: 'local-proxy',
    localProxyHost,
    localProxyPort,
    remoteProxyPort,
    proxyUrl,
    proxyProbe: probe,
    child,
  };
}
