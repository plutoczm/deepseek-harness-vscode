import { runSsh } from './ssh.mjs';

const MARKER = '__DHR_BALANCE__';

function parsePayload(stdout) {
  for (const line of String(stdout).split(/\r?\n/u).reverse()) {
    if (!line.startsWith(MARKER)) continue;
    try {
      return JSON.parse(line.slice(MARKER.length));
    } catch {
      return { available: false, error: 'Invalid balance response.' };
    }
  }
  return { available: false, error: 'DeepSeek API balance response was not found.' };
}

export async function readDeepSeekBalance(host) {
  const script = String.raw`set +e
if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  printf '${MARKER}%s\n' '{"available":false,"error":"DEEPSEEK_API_KEY is not available in the remote login shell."}'
  exit 0
fi
node - <<'NODE'
const marker = '${MARKER}';
(async () => {
  try {
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    if (!response.ok) {
      console.log(marker + JSON.stringify({ available: false, error: `DeepSeek balance API returned HTTP ${response.status}.` }));
      return;
    }
    const data = JSON.parse(text);
    console.log(marker + JSON.stringify({
      available: true,
      isAvailable: Boolean(data.is_available),
      balances: Array.isArray(data.balance_infos) ? data.balance_infos.map((item) => ({
        currency: String(item.currency || ''),
        total: Number(item.total_balance || 0),
        granted: Number(item.granted_balance || 0),
        toppedUp: Number(item.topped_up_balance || 0),
      })) : [],
      sampledAt: new Date().toISOString(),
    }));
  } catch (error) {
    console.log(marker + JSON.stringify({ available: false, error: error?.message || String(error) }));
  }
})();
NODE
`;
  const { stdout } = await runSsh(host, script, { timeoutMs: 15000, interactiveShell: true, maxBytes: 1024 * 1024 });
  return parsePayload(stdout);
}

export function balanceDelta(baseline, current) {
  if (!baseline?.available || !current?.available) return [];
  const initial = new Map((baseline.balances || []).map((item) => [item.currency, item]));
  return (current.balances || []).map((item) => ({
    currency: item.currency,
    amount: Math.max(0, Number(initial.get(item.currency)?.total ?? item.total) - Number(item.total || 0)),
  }));
}
