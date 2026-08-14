export const name = 'remote-usage-cost';
export const inject = ['llm'];

const MARKER = '__DHR_USAGE__';

function emitUsage(options, usage, startedAt) {
  const sessionId = options?.sessionId ? String(options.sessionId) : '';
  if (!sessionId) return;

  const payload = {
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
  };

  try {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    process.stdout.write(`${MARKER}${encoded}\n`);
  } catch {
    // Usage telemetry must never interfere with model streaming.
  }
}

async function* observeStream(options, source, startedAt) {
  for await (const chunk of source) {
    if (chunk?.type === 'usage') emitUsage(options, chunk.usage, startedAt);
    yield chunk;
  }
}

export function apply(ctx) {
  ctx.on('llm/stream', (options, next) => {
    const startedAt = new Date().toISOString();
    return observeStream(options, next(), startedAt);
  }, { global: true });
}
