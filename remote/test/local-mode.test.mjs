import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listLocalDirectories } from '../src/local-manager.mjs';
import { UnifiedHarnessManager } from '../src/unified-manager.mjs';
import { AppearanceStore, DEFAULT_WALLPAPER_URL } from '../src/appearance.mjs';

class FakeManager extends EventEmitter {
  constructor(items = []) {
    super();
    this.instances = new Map(items.map((item) => [item.id, item]));
  }
  list() { return [...this.instances.values()]; }
  get(id) { return this.instances.get(id); }
  logs(id) { return this.instances.get(id)?.logs || ''; }
  usage(id) { return this.instances.has(id) ? { id } : undefined; }
  balance(id) { return this.instances.has(id) ? { id } : undefined; }
  async stop(id) { return this.instances.has(id); }
  async stopAll() {}
  async launch(options) { return { ...options, launched: true }; }
}

test('lists local workspace directories with platform-native paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-local-'));
  try {
    await mkdir(path.join(root, 'alpha'));
    await mkdir(path.join(root, 'beta'));
    const result = await listLocalDirectories(root);
    assert.equal(result.current, path.resolve(root));
    assert.equal(result.parent, path.dirname(path.resolve(root)));
    assert.deepEqual(result.directories.map((item) => item.name), ['alpha', 'beta']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unified manager routes local and SSH instances', async () => {
  const remote = new FakeManager([{ id: 'ssh-1', host: 'server', createdAt: '2026-01-01T00:00:00Z' }]);
  const local = new FakeManager([{ id: 'local-1', host: 'Local', mode: 'local', createdAt: '2026-01-02T00:00:00Z' }]);
  const manager = new UnifiedHarnessManager(remote, local);
  const list = manager.list();
  assert.equal(list[0].id, 'local-1');
  assert.equal(list[0].mode, 'local');
  assert.equal(list[1].mode, 'ssh');
  assert.deepEqual(manager.usage('ssh-1'), { id: 'ssh-1' });
  assert.deepEqual(manager.balance('local-1'), { id: 'local-1' });
  assert.equal(await manager.stop('local-1'), true);
});

test('appearance settings persist and clamp visual controls', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-appearance-'));
  try {
    const store = new AppearanceStore(root);
    const saved = await store.set({ enabled: true, imageUrl: 'http://not-https.example/test.jpg', opacity: 5, blur: 99 });
    assert.equal(saved.imageUrl, DEFAULT_WALLPAPER_URL);
    assert.equal(saved.opacity, 50);
    assert.equal(saved.blur, 32);
    const reloaded = new AppearanceStore(root);
    const value = await reloaded.get();
    assert.equal(value.imageUrl, DEFAULT_WALLPAPER_URL);
    assert.equal(value.opacity, 50);
    assert.equal(value.blur, 32);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
