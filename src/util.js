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
    extraAliases: String(input.extraAliases ?? process.env.DSH_SSH_ALIASES ?? '')
      .split(/[\s,]+/u)
      .map((value) => value.trim())
      .filter(Boolean),
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

function stripBrackets(value) {
  const text = String(value || '').trim();
  return text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
}

/** Parse OpenSSH's host:port forms, including [IPv6]:port and bare ports. */
export function parseForwardEndpoint(value, defaultHost = '127.0.0.1') {
  const text = String(value || '').trim();
  if (/^\d+$/u.test(text)) return { host: defaultHost, port: Number(text) };

  if (text.startsWith('[')) {
    const close = text.lastIndexOf(']:');
    if (close > 0) {
      return {
        host: text.slice(1, close),
        port: Number(text.slice(close + 2)),
      };
    }
  }

  const colon = text.lastIndexOf(':');
  if (colon <= 0) return { host: defaultHost, port: Number.NaN };
  return {
    host: stripBrackets(text.slice(0, colon)),
    port: Number(text.slice(colon + 1)),
  };
}

/** Parse one `ssh -G <alias>` output without re-implementing OpenSSH config rules. */
export function parseOpenSshConfig(output, alias = '') {
  const result = {
    alias: String(alias),
    hostname: String(alias),
    user: '',
    port: 22,
    identityFiles: [],
    proxyJump: undefined,
    proxyCommand: undefined,
    remoteForwards: [],
  };

  for (const raw of String(output || '').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    const space = line.search(/\s/u);
    if (space < 0) continue;
    const key = line.slice(0, space).toLowerCase();
    const value = line.slice(space).trim();

    if (key === 'hostname') result.hostname = value;
    else if (key === 'user') result.user = value;
    else if (key === 'port') result.port = Number(value) || 22;
    else if (key === 'identityfile') result.identityFiles.push(value);
    else if (key === 'proxyjump' && value.toLowerCase() !== 'none') result.proxyJump = value;
    else if (key === 'proxycommand' && value.toLowerCase() !== 'none') result.proxyCommand = value;
    else if (key === 'remoteforward') {
      const parts = value.split(/\s+/u);
      if (parts.length < 2) continue;
      const listen = parseForwardEndpoint(parts[0], '127.0.0.1');
      const target = parseForwardEndpoint(parts[1], '127.0.0.1');
      if (!Number.isInteger(listen.port) || !Number.isInteger(target.port)) continue;
      result.remoteForwards.push({
        listenHost: listen.host,
        listenPort: listen.port,
        targetHost: target.host,
        targetPort: target.port,
        raw: value,
      });
    }
  }

  return result;
}

function normalizeLoopback(host) {
  const value = stripBrackets(host).toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') return '127.0.0.1';
  return value;
}

/** Find a configured RemoteForward whose local target is the Windows VPN proxy. */
export function matchingProxyForward(openSshConfig, config) {
  const wantedHost = normalizeLoopback(config.localProxyHost);
  return (openSshConfig?.remoteForwards || []).find((forward) =>
    normalizeLoopback(forward.targetHost) === wantedHost
    && Number(forward.targetPort) === Number(config.localProxyPort));
}

/** Concrete aliases from ordinary Host lines. Wildcards are intentionally excluded. */
export function parseConcreteHostAliases(text) {
  const aliases = new Set();
  for (const raw of String(text || '').split(/\r?\n/u)) {
    const match = /^\s*Host\s+(.+)$/iu.exec(raw);
    if (!match) continue;
    for (const token of match[1].trim().split(/\s+/u)) {
      if (!token || token.startsWith('!') || /[*?]/u.test(token)) continue;
      aliases.add(token);
    }
  }
  return [...aliases];
}
