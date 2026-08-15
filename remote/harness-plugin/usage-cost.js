import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'remote-usage-cost';
export const inject = ['llm'];

const USAGE_MARKER = '__DHR_USAGE__';
const BALANCE_MARKER = '__DHR_BALANCE__';
const BALANCE_REFRESH_MS = 30_000;
const BALANCE_AFTER_USAGE_MS = 1_500;
const BALANCE_MIN_QUERY_GAP_MS = 2_000;
const BALANCE_TIMEOUT_MS = 8_000;

function emitMarker(marker, payload) {
  try {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    process.stdout.write(`${marker}${encoded}\n`);
  } catch {
    // Telemetry must never interfere with model streaming.
  }
}

function emitUsage(options, usage, startedAt) {
  const sessionId = options?.sessionId ? String(options.sessionId) : '';
  if (!sessionId) return;

  emitMarker(USAGE_MARKER, {
    version: 2,
    sessionId,
    provider: String(options.provider || ''),
    model: String(options.model || ''),
    purpose: options?.purpose ? String(options.purpose) : null,
    // Pricing must be anchored to the request start, not to the later usage
    // chunk arrival. This matters if a provider changes price at a time boundary.
    startedAt,
    usage: {
      inputTokens: Number(usage?.inputTokens || 0),
      outputTokens: Number(usage?.outputTokens || 0),
      cacheReadTokens: Number(usage?.cacheReadTokens || 0),
      cacheWriteTokens: Number(usage?.cacheWriteTokens || 0),
      reasoningTokens: Number(usage?.reasoningTokens || 0),
    },
    at: new Date().toISOString(),
  });
}

function decodeYamlScalar(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      const decoded = JSON.parse(value);
      return typeof decoded === 'string' ? decoded : '';
    } catch {
      return value.slice(1, -1);
    }
  }
  return value.replace(/\s+#.*$/u, '').trim();
}

function credentialFromYaml(contents, key) {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`^\\s*${escaped}\\s*:\\s*(.*?)\\s*$`, 'u');
  for (const line of String(contents || '').split(/\r?\n/u)) {
    if (/^\s*#/u.test(line)) continue;
    const match = pattern.exec(line);
    if (!match) continue;
    const value = decodeYamlScalar(match[1]);
    if (value) return value;
  }
  return undefined;
}

async function resolveApiKey() {
  const ambient = process.env.DEEPSEEK_API_KEY?.trim();
  if (ambient) return ambient;

  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  try {
    const contents = await readFile(join(dshHome, '.credentials.yaml'), 'utf8');
    return credentialFromYaml(contents, 'DEEPSEEK_API_KEY');
  } catch {
    return undefined;
  }
}

function numericBalance(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function selectBalanceInfo(balanceInfos) {
  if (!Array.isArray(balanceInfos) || balanceInfos.length === 0) return undefined;
  return balanceInfos.find((item) => String(item?.currency || '').toUpperCase() === 'CNY') || balanceInfos[0];
}

let balanceInflight;
let lastBalanceQueryAt = 0;
let afterUsageTimer;

async function queryBalance() {
  const fetchedAt = new Date().toISOString();
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    emitMarker(BALANCE_MARKER, {
      version: 1,
      ok: false,
      available: false,
      error: '未找到 DEEPSEEK_API_KEY',
      fetchedAt,
    });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      emitMarker(BALANCE_MARKER, {
        version: 1,
        ok: false,
        available: false,
        error: `余额接口 HTTP ${response.status}`,
        fetchedAt,
      });
      return;
    }

    const payload = await response.json();
    const info = selectBalanceInfo(payload?.balance_infos);
    emitMarker(BALANCE_MARKER, {
      version: 1,
      ok: true,
      available: payload?.is_available !== false,
      currency: info ? String(info.currency || 'CNY').toUpperCase() : 'CNY',
      total: info ? numericBalance(info.total_balance) : null,
      granted: info ? numericBalance(info.granted_balance) : null,
      toppedUp: info ? numericBalance(info.topped_up_balance) : null,
      fetchedAt,
    });
  } catch (error) {
    emitMarker(BALANCE_MARKER, {
      version: 1,
      ok: false,
      available: false,
      error: error?.name === 'AbortError'
        ? '余额查询超时'
        : (error instanceof Error ? error.message : String(error)),
      fetchedAt,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function refreshBalance({ force = false } = {}) {
  if (balanceInflight) return balanceInflight;
  const now = Date.now();
  if (!force && now - lastBalanceQueryAt < BALANCE_MIN_QUERY_GAP_MS) return Promise.resolve();
  lastBalanceQueryAt = now;
  balanceInflight = queryBalance().finally(() => {
    balanceInflight = undefined;
  });
  return balanceInflight;
}

function refreshBalanceAfterUsage() {
  clearTimeout(afterUsageTimer);
  afterUsageTimer = setTimeout(() => {
    refreshBalance().catch(() => undefined);
  }, BALANCE_AFTER_USAGE_MS);
  afterUsageTimer.unref?.();
}

async function* observeStream(options, source, startedAt) {
  for await (const chunk of source) {
    if (chunk?.type === 'usage') {
      emitUsage(options, chunk.usage, startedAt);
      refreshBalanceAfterUsage();
    }
    yield chunk;
  }
}

export function apply(ctx) {
  // Balance is an ordinary account HTTP query. It never calls a model and
  // therefore cannot add prompt/completion tokens. Query once at startup,
  // periodically as a fallback, and shortly after provider usage events.
  const startup = setTimeout(() => {
    refreshBalance({ force: true }).catch(() => undefined);
  }, 250);
  startup.unref?.();

  const interval = setInterval(() => {
    refreshBalance().catch(() => undefined);
  }, BALANCE_REFRESH_MS);
  interval.unref?.();

  ctx.on('llm/stream', (options, next) => {
    const startedAt = new Date().toISOString();
    return observeStream(options, next(), startedAt);
  }, { global: true });
}
