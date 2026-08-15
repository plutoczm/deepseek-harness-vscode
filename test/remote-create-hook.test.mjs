import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installRemoteSessionCreateHook } from '../src/remote-create-hook.js';
import { REMOTE_MANIFEST, REMOTE_PRESET_ID } from '../src/remote-workspace.js';

test('native workspace session.create is forced onto openssh-remote only for SSH anchors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-openssh-hook-'));
  const remoteAnchor = join(root, 'remote');
  const localAnchor = join(root, 'local');
  mkdirSync(remoteAnchor, { recursive: true });
  mkdirSync(localAnchor, { recursive: true });
  writeFileSync(join(remoteAnchor, REMOTE_MANIFEST), JSON.stringify({
    version: 1,
    alias: 'gdwyy70',
    remotePath: '/mnt/ext-disk/czm2025/Projects/face_privacy_tkde',
    title: 'face_privacy_tkde · gdwyy70',
  }));

  try {
    const seen = [];
    const sessions = {
      async create(request) {
        seen.push(request.payload);
        return { rpcId: request.rpcId, result: { ok: true, value: { sessionId: 'session-test' } } };
      },
    };
    const apiProxy = { sessions };
    const workspaceRegistry = {
      list() {
        return [
          { id: 'workspace-remote', path: remoteAnchor },
          { id: 'workspace-local', path: localAnchor },
        ];
      },
    };
    const ctx = {
      get(name) {
        if (name === 'apiProxy') return apiProxy;
        if (name === 'workspaceRegistry') return workspaceRegistry;
        return undefined;
      },
      logger: { warn() {} },
    };

    const dispose = installRemoteSessionCreateHook(ctx);
    await sessions.create({ rpcId: '1', payload: { workspaceId: 'workspace-remote' } });
    await sessions.create({ rpcId: '2', payload: { workspaceId: 'workspace-local' } });
    await sessions.create({ rpcId: '3', payload: { cwd: 'C:/tmp' } });

    assert.equal(seen[0].agentPreset, REMOTE_PRESET_ID);
    assert.deepEqual(seen[1], { workspaceId: 'workspace-local' });
    assert.deepEqual(seen[2], { cwd: 'C:/tmp' });

    dispose();
    await sessions.create({ rpcId: '4', payload: { workspaceId: 'workspace-remote' } });
    assert.deepEqual(seen[3], { workspaceId: 'workspace-remote' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
