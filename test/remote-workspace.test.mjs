import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  REMOTE_MANIFEST,
  REMOTE_PRESET_ID,
  ensureRemoteWorkspacePreset,
  openRemoteWorkspace,
  readRemoteWorkspaceManifest,
} from '../src/remote-workspace.js';

function ok(rpcId, value) {
  return { rpcId, result: { ok: true, value } };
}

test('remote workspace uses a local anchor but creates an openssh-remote Harness session', async () => {
  const oldHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'dsh-openssh-vpn-workspace-'));
  process.env.DSH_HOME = home;
  try {
    let workspace = null;
    const apiProxy = {
      workspace: {
        async create(request) {
          workspace = {
            workspaceId: 'workspace-test',
            path: request.payload.path,
            title: 'old title',
            sessionIds: [],
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          };
          return ok(request.rpcId, { workspace, created: true });
        },
        async rename(request) {
          workspace = { ...workspace, title: request.payload.title };
          return ok(request.rpcId, { workspace });
        },
        async list(request) {
          return ok(request.rpcId, { items: workspace ? [workspace] : [], archivedSessionIds: [] });
        },
      },
      sessions: {
        async list(request) { return ok(request.rpcId, { items: [] }); },
        async create(request) {
          assert.equal(request.payload.workspaceId, 'workspace-test');
          assert.equal(request.payload.agentPreset, REMOTE_PRESET_ID);
          return ok(request.rpcId, { sessionId: 'session-remote', agentPreset: REMOTE_PRESET_ID });
        },
      },
    };
    const ctx = { get(name) { return name === 'apiProxy' ? apiProxy : undefined; } };
    const engine = {
      async exec(alias, command) {
        assert.equal(alias, 'gdwyy70');
        assert.match(command, /face_privacy_tkde/u);
        return { success: true, stdout: 'DSH_REMOTE_WORKSPACE_OK', stderr: '', exitCode: 0 };
      },
    };

    const opened = await openRemoteWorkspace(
      ctx,
      engine,
      'gdwyy70',
      '/mnt/ext-disk/czm2025/Projects/face_privacy_tkde',
    );
    assert.equal(opened.workspaceId, 'workspace-test');
    assert.equal(opened.sessionId, 'session-remote');
    assert.equal(opened.agentPreset, REMOTE_PRESET_ID);
    assert.equal(opened.title, 'face_privacy_tkde · gdwyy70');

    const manifest = readRemoteWorkspaceManifest(opened.anchor);
    assert.equal(manifest.alias, 'gdwyy70');
    assert.equal(manifest.remotePath, '/mnt/ext-disk/czm2025/Projects/face_privacy_tkde');
    assert.ok(readFileSync(join(opened.anchor, REMOTE_MANIFEST), 'utf8').includes('gdwyy70'));

    const preset = ensureRemoteWorkspacePreset();
    assert.equal(preset.id, REMOTE_PRESET_ID);
    const composition = readFileSync(preset.path, 'utf8');
    assert.match(composition, /dsh-openssh-vpn\/remote-tools/u);
    assert.doesNotMatch(composition, /dsh-tool-fs/u);
    assert.doesNotMatch(composition, /dsh-tool-pwsh/u);
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
