import { spawn } from 'node:child_process';
import path from 'node:path';
import { validateHost, validateRemotePath } from './config.mjs';
import { runSsh } from './ssh.mjs';

const MAX_TEXT_PREVIEW_BYTES = 1 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 15 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 5000;

const IMAGE_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
]);

const PDF_MIME = 'application/pdf';
const STREAM_SSH_OPTIONS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=20',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ClearAllForwardings=yes',
];

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

export async function remoteFileMetadata(hostInput, remotePathInput) {
  const host = validateHost(hostInput);
  const remotePath = validateRemotePath(remotePathInput);
  const quoted = shellQuote(remotePath);
  const script = `set -e\nFILE=${quoted}\nif [ ! -f "$FILE" ]; then echo "Remote file does not exist or is not a regular file: $FILE" >&2; exit 2; fi\nSIZE="$(stat -c '%s' "$FILE" 2>/dev/null || wc -c < "$FILE" | tr -d ' ')"\nMTIME="$(stat -c '%Y' "$FILE" 2>/dev/null || printf '0')"\nprintf '__SIZE__=%s\\n__MTIME__=%s\\n' "$SIZE" "$MTIME"\n`;
  const { stdout } = await runSsh(host, script, { timeoutMs: 20000, maxBytes: 4096 });
  const size = Number(/^__SIZE__=(\d+)$/mu.exec(stdout)?.[1]);
  const mtimeSeconds = Number(/^__MTIME__=(\d+)$/mu.exec(stdout)?.[1]);
  if (!Number.isFinite(size) || size < 0) throw new Error('Could not determine remote file size.');
  return {
    host,
    path: remotePath,
    name: path.posix.basename(remotePath),
    size,
    mtime: Number.isFinite(mtimeSeconds) && mtimeSeconds > 0
      ? new Date(mtimeSeconds * 1000).toISOString()
      : undefined,
    extension: path.posix.extname(remotePath).toLowerCase(),
  };
}

export function parseHttpByteRange(header, size) {
  const total = Number(size);
  if (!Number.isSafeInteger(total) || total < 0) return null;
  if (!header) return total === 0 ? { start: 0, end: -1, length: 0, partial: false } : { start: 0, end: total - 1, length: total, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;

  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || total === 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start < 0 || start >= total) return null;
    end = match[2] === '' ? total - 1 : Number(match[2]);
    if (!Number.isSafeInteger(end) || end < start) return null;
    end = Math.min(end, total - 1);
  }
  return { start, end, length: end - start + 1, partial: true };
}

export function openRemoteFileStream(hostInput, remotePathInput, { start = 0, length } = {}) {
  const host = validateHost(hostInput);
  const remotePath = validateRemotePath(remotePathInput);
  const offset = Number(start);
  const count = Number(length);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid remote stream offset.');
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid remote stream length.');

  const quoted = shellQuote(remotePath);
  const script = count === 0
    ? `set -e\nFILE=${quoted}\n[ -f "$FILE" ] || exit 2\nexit 0\n`
    : offset === 0
      ? `set -e\nFILE=${quoted}\n[ -f "$FILE" ] || exit 2\nhead -c ${count} "$FILE"\n`
      : `set -e\nFILE=${quoted}\n[ -f "$FILE" ] || exit 2\ntail -c +${offset + 1} "$FILE" | head -c ${count}\n`;
  const child = spawn('ssh', [...STREAM_SSH_OPTIONS, host, 'bash', '-s'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(script);
  return child;
}

export async function readRemoteFile(hostInput, remotePathInput) {
  const host = validateHost(hostInput);
  const remotePath = validateRemotePath(remotePathInput);
  const extension = path.posix.extname(remotePath).toLowerCase();

  if (extension === '.pdf') {
    const metadata = await remoteFileMetadata(host, remotePath);
    return {
      ...metadata,
      kind: 'pdf',
      mime: PDF_MIME,
    };
  }

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
