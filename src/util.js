export function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

export function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'direct' || mode === 'proxy' || mode === 'auto' ? mode : 'auto';
}

export function normalizeConfig(input = {}) {
  return {
    mode: normalizeMode(input.mode ?? process.env.DSH_SSH_PROXY_MODE ?? 'auto'),
    localProxyHost: String(input.localProxyHost ?? process.env.DSH_SSH_PROXY_HOST ?? '127.0.0.1'),
    localProxyPort: clampInteger(input.localProxyPort ?? process.env.DSH_SSH_PROXY_PORT, 7890, 1, 65535),
    remotePortStart: clampInteger(input.remotePortStart ?? process.env.DSH_SSH_PROXY_REMOTE_PORT, 17890, 1024, 65515),
    healthIntervalMs: clampInteger(input.healthIntervalMs ?? process.env.DSH_SSH_PROXY_HEALTH_INTERVAL_MS, 60_000, 15_000, 600_000),
    probeTimeoutMs: clampInteger(input.probeTimeoutMs, 8_000, 2_000, 20_000),
    noProxy: String(input.noProxy ?? process.env.DSH_SSH_PROXY_NO_PROXY ?? 'api.deepseek.com,.deepseek.com,127.0.0.1,localhost,::1'),
  };
}

export function parseSshUri(uri) {
  const url = new URL(uri);
  if (url.protocol !== 'ssh:') throw new Error(`Expected ssh:// URI, got ${uri}`);
  const host = url.hostname;
  const username = decodeURIComponent(url.username || '');
  const port = Number(url.port || 22);
  const path = decodeURIComponent(url.pathname || '/') || '/';
  return {
    host,
    username,
    port,
    path,
    destination: username ? `${username}@${host}` : host,
  };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function proxyEnvironment(remotePort, config) {
  const proxy = `http://127.0.0.1:${remotePort}`;
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: config.noProxy,
    no_proxy: config.noProxy,
  };
}

export function prefixShellEnvironment(command, environment) {
  const exports = Object.entries(environment || {})
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  if (exports.length === 0) return command;
  return `${exports.join('; ')}; ${command}`;
}

export function remoteUriForCwd(service, cwd) {
  if (!cwd || typeof cwd !== 'string') return undefined;
  if (cwd.startsWith('ssh://')) return cwd;
  return service.resolveRemotePath(cwd);
}
