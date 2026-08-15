import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const MAX_RECENTS = 12;

function workspaceName(workspace) {
  const value = String(workspace || '').replace(/[\\/]+$/u, '');
  return value.split(/[\\/]/u).filter(Boolean).at(-1) || value || 'Workspace';
}

function normalizeEntry(value = {}) {
  const mode = value.mode === 'ssh' ? 'ssh' : 'local';
  const workspace = String(value.workspace || '').trim();
  if (!workspace) return undefined;
  const host = mode === 'ssh' ? String(value.host || '').trim() : 'Local';
  if (mode === 'ssh' && !host) return undefined;
  const lastUsed = Number.isFinite(Date.parse(value.lastUsed)) ? new Date(value.lastUsed).toISOString() : new Date().toISOString();
  return {
    key: `${mode}:${host}:${workspace}`,
    name: workspaceName(workspace),
    mode,
    host,
    workspace,
    lastUsed,
  };
}

export class RecentWorkspaceStore {
  constructor(directory = process.env.DSH_REMOTE_SETTINGS_DIR || path.join(homedir(), '.deepseek-harness-remote')) {
    this.directory = directory;
    this.file = path.join(directory, 'recent-workspaces.json');
    this.items = [];
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this.items;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      const values = Array.isArray(parsed) ? parsed : parsed?.items;
      this.items = (Array.isArray(values) ? values : [])
        .map(normalizeEntry)
        .filter(Boolean)
        .sort((a, b) => Date.parse(b.lastUsed) - Date.parse(a.lastUsed))
        .slice(0, MAX_RECENTS);
    } catch {
      this.items = [];
    }
    return this.items;
  }

  async get() {
    await this.load();
    return this.items.map((item) => ({ ...item }));
  }

  async remember(value = {}) {
    await this.load();
    const entry = normalizeEntry({ ...value, lastUsed: new Date().toISOString() });
    if (!entry) throw new Error('A valid workspace is required.');
    this.items = [entry, ...this.items.filter((item) => item.key !== entry.key)].slice(0, MAX_RECENTS);
    await this.save();
    return { ...entry };
  }

  async remove(key) {
    await this.load();
    const before = this.items.length;
    this.items = this.items.filter((item) => item.key !== String(key || ''));
    if (this.items.length !== before) await this.save();
    return this.items.length !== before;
  }

  async clear() {
    await this.load();
    this.items = [];
    await this.save();
  }

  async save() {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.file, `${JSON.stringify({ items: this.items }, null, 2)}\n`, 'utf8');
  }
}

export const recentWorkspaceStore = new RecentWorkspaceStore();
