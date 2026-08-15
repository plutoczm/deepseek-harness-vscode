import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RecentWorkspaceStore } from '../src/recent-workspaces.mjs';

test('recent workspace store persists and deduplicates Local and SSH workspaces', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-recents-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const store = new RecentWorkspaceStore(directory);
  await store.remember({ mode: 'local', workspace: 'C:\\Projects\\alpha' });
  await store.remember({ mode: 'ssh', host: 'gpu-box', workspace: '/home/user/beta' });
  await store.remember({ mode: 'local', workspace: 'C:\\Projects\\alpha' });

  const items = await store.get();
  assert.equal(items.length, 2);
  assert.equal(items[0].mode, 'local');
  assert.equal(items[0].host, 'Local');
  assert.equal(items[0].name, 'alpha');
  assert.equal(items[1].mode, 'ssh');
  assert.equal(items[1].host, 'gpu-box');

  const reloaded = new RecentWorkspaceStore(directory);
  const persisted = await reloaded.get();
  assert.deepEqual(
    persisted.map(({ key, name, mode, host, workspace }) => ({ key, name, mode, host, workspace })),
    items.map(({ key, name, mode, host, workspace }) => ({ key, name, mode, host, workspace })),
  );
});

test('recent workspace store rejects invalid SSH entries and can clear history', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-recents-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const store = new RecentWorkspaceStore(directory);
  await assert.rejects(() => store.remember({ mode: 'ssh', workspace: '/tmp/project' }), /valid workspace/u);
  await store.remember({ mode: 'local', workspace: '/tmp/project' });
  assert.equal((await store.get()).length, 1);
  await store.clear();
  assert.deepEqual(await store.get(), []);
});
