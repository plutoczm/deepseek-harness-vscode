export const name = 'remote-usage-cost';
export const inject = ['llm'];

const MARKER = '__DHR_USAGE__';

function emitUsage(options, usage) {
  const sessionId = options?.sessionId ? String(options.sessionId) : '';
  // Keep this aligned with the native conversation tokenUsage projection:
  // auxiliary title/compaction calls are not part of the visible conversation
  // stats line, so they are intentionally excluded here too.
  if (!sessionId || options?.purpose) return;

  const payload = {
    version: 1,
    sessionId,
    provider: String(options.provider || ''),
    model: String(options.model || ''),
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

async function* observeStream(options, source) {
  for await (const chunk of source) {
    if (chunk?.type === 'usage') emitUsage(options, chunk.usage);
    yield chunk;
  }
}

export function apply(ctx) {
  ctx.on('llm/stream', (options, next) => observeStream(options, next()), { global: true });
}
