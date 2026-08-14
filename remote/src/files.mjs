import path from 'node:path';
import { validateHost, validateRemotePath } from './config.mjs';
import { runSsh } from './ssh.mjs';

const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 5000;

const IMAGE_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
]);

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function entryType(value, targetType) {
  if (value === 'd' || (value === 'l' && targetType === 'd')) return 'directory';
  if (value === 'f') return 'file';
  if (value === 'l') return 'symlink';
  return 'other';
}

function isLikelyBinary(buffer) {
  if (!buffer.length) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return controls / sample.length > 0.08;
}

export async function listRemoteFiles(hostInput, remotePathInput = '/') {
  const host = validateHost(hostInput);
  const remotePath = validateRemotePath(remotePathInput || '/');
  const quoted = shellQuote(remotePath);
  const fieldLimit = MAX_DIRECTORY_ENTRIES * 6;
  const script = `set -e\nTARGET=${quoted}\nif [ ! -d "$TARGET" ]; then echo "Remote directory does not exist or is not accessible: $TARGET" >&2; exit 2; fi\nCURRENT="$(cd "$TARGET" && pwd -P)"\nprintf '__CURRENT__\\0%s\\0' "$CURRENT"\nfind "$CURRENT" -mindepth 1 -maxdepth 1 -printf '%y\\0%Y\\0%s\\0%T@\\0%f\\0%p\\0' 2>/dev/null | head -z -n ${fieldLimit}\n`;
  const { stdout } = await runSsh(host, script, { timeoutMs: 30000, maxBytes: 8 * 1024 * 1024 });
  const fields = stdout.split('\0');
  if (fields[0] !== '__CURRENT__') throw new Error('Could not parse remote directory listing.');
  const current = fields[1] || remotePath;
  const entries = [];
  for (let index = 2; index + 5 < fields.length; index += 6) {
    const [rawType, rawTargetType, rawSize, rawMtime, name, entryPath] = fields.slice(index, index + 6);
    if (!name || !entryPath) continue;
    const type = entryType(rawType, rawTargetType);
    const seconds = Number(rawMtime);
    entries.push({
      name,
      path: entryPath,
      type,
      symlink: rawType === 'l',
      size: Number(rawSize) || 0,
      mtime: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined,
    });
  }
  entries.sort((left, right) => {
    const rank = (item) => item.type === 'directory' ? 0 : item.type === 'symlink' ? 1 : 2;
    return rank(left) - rank(right) || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  const parent = current === '/' ? '/' : path.posix.dirname(current);
  return {
    host,
    current,
    parent,
    entries,
    limited: entries.length >= MAX_DIRECTORY_ENTRIES,
    limit: MAX_DIRECTORY_ENTRIES,
  };
}

export async function readRemoteFile(hostInput, remotePathInput) {
  const host = validateHost(hostInput);
  const remotePath = validateRemotePath(remotePathInput);
  const extension = path.posix.extname(remotePath).toLowerCase();
  const imageMime = IMAGE_MIME.get(extension);
  const maxBytes = imageMime ? MAX_IMAGE_PREVIEW_BYTES : MAX_TEXT_PREVIEW_BYTES;
  const quoted = shellQuote(remotePath);
  const script = `set -e\nFILE=${quoted}\nif [ ! -f "$FILE" ]; then echo "Remote file does not exist or is not a regular file: $FILE" >&2; exit 2; fi\nSIZE="$(wc -c < "$FILE" | tr -d ' ')"\nprintf '__SIZE__=%s\\n' "$SIZE"\nhead -c ${maxBytes} "$FILE" | base64 | tr -d '\\n'\n`;
  const { stdout } = await runSsh(host, script, { timeoutMs: 30000, maxBytes: Math.ceil(maxBytes * 1.5) + 4096 });
  const newline = stdout.indexOf('\n');
  if (newline < 0 || !stdout.startsWith('__SIZE__=')) throw new Error('Could not parse remote file preview.');
  const size = Number(stdout.slice('__SIZE__='.length, newline).trim()) || 0;
  const encoded = stdout.slice(newline + 1).trim();
  const buffer = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
  const truncated = size > maxBytes;

  if (imageMime) {
    return {
      host,
      path: remotePath,
      name: path.posix.basename(remotePath),
      size,
      truncated,
      kind: truncated ? 'binary' : 'image',
      mime: imageMime,
      base64: truncated ? undefined : buffer.toString('base64'),
      previewLimit: maxBytes,
    };
  }

  if (isLikelyBinary(buffer)) {
    return {
      host,
      path: remotePath,
      name: path.posix.basename(remotePath),
      size,
      truncated,
      kind: 'binary',
      previewLimit: maxBytes,
    };
  }

  return {
    host,
    path: remotePath,
    name: path.posix.basename(remotePath),
    size,
    truncated,
    kind: 'text',
    content: buffer.toString('utf8'),
    previewLimit: maxBytes,
  };
}
