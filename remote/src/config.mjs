import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MIN_REMOTE_NODE = [22, 19, 0];

export function parseSshConfig(text) {
  const hosts = [];
  const seen = new Set();
  for (const rawLine of String(text).split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, '').trim();
    const match = /^Host\s+(.+)$/iu.exec(line);
    if (!match) continue;
    for (const token of match[1].trim().split(/\s+/u)) {
      if (!token || /[*?!]/u.test(token) || token.startsWith('!')) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      hosts.push(token);
    }
  }
  return hosts;
}

export async function loadSshHosts() {
  const configPath = path.join(os.homedir(), '.ssh', 'config');
  try {
    const text = await fs.readFile(configPath, 'utf8');
    return { configPath, hosts: parseSshConfig(text) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { configPath, hosts: [] };
    throw error;
  }
}

export function parseNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(String(value ?? '').trim());
  return match ? match.slice(1, 4).map(Number) : undefined;
}

export function compareVersions(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

export function isSupportedRemoteNode(value) {
  const version = parseNodeVersion(value);
  return Boolean(version && compareVersions(version, MIN_REMOTE_NODE) >= 0);
}

export function validateHost(host) {
  const value = String(host ?? '').trim();
  if (!value || value.length > 255 || /[\0\r\n]/u.test(value)) {
    throw new Error('Invalid SSH host or alias.');
  }
  return value;
}

export function validateRemotePath(remotePath) {
  const value = String(remotePath ?? '').trim();
  if (!value || /[\0\r\n]/u.test(value)) throw new Error('Invalid remote path.');
  return value;
}
