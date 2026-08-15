import { randomUUID } from 'node:crypto';
import { readRemoteWorkspaceManifest, REMOTE_PRESET_ID } from './remote-workspace.js';

function rpcRequest(payload) {
  return { rpcId: `openssh-vpn-connect-${randomUUID()}`, payload };
}

function unwrap(method, response) {
  if (!response?.result?.ok) {
    const error = response?.result?.error;
    throw new Error(`${method} failed: ${error?.code || 'unknown'}: ${error?.message || 'unknown error'}`);
  }
  return response.result.value;
}

/**
 * Connect one official Harness Workspace while preserving its SSH remote
 * composition. Returns { remote:false } for ordinary local workspaces so the
 * browser can fall through to Harness' original connectWorkspace method.
 */
export async function connectRemoteWorkspace(ctx, workspaceIdInput) {
  const workspaceId = String(workspaceIdInput || '').trim();
  if (!workspaceId) throw new Error('workspaceId is required');

  const apiProxy = ctx.get?.('apiProxy');
  if (!apiProxy?.workspace || !apiProxy?.sessions) {
    throw new Error('Harness apiProxy is unavailable');
  }

  const listed = unwrap('workspace.list', await apiProxy.workspace.list(rpcRequest({})));
  const workspace = (listed.items || []).find((item) => item.workspaceId === workspaceId);
  if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);

  const manifest = readRemoteWorkspaceManifest(workspace.path);
  if (!manifest) return { ok: true, remote: false, workspaceId };

  const sessions = unwrap('session.list', await apiProxy.sessions.list(rpcRequest({})));
  const archived = new Set(listed.archivedSessionIds || []);
  const attached = new Set(workspace.sessionIds || []);
  const reusable = (sessions.items || []).find((item) =>
    attached.has(item.sessionId)
    && !archived.has(item.sessionId)
    && item.blank === true
    && item.agentPreset === REMOTE_PRESET_ID);

  if (reusable) {
    return {
      ok: true,
      remote: true,
      workspaceId,
      sessionId: reusable.sessionId,
      alias: manifest.alias,
      remotePath: manifest.remotePath,
      agentPreset: REMOTE_PRESET_ID,
      reused: true,
    };
  }

  const created = unwrap(
    'session.create',
    await apiProxy.sessions.create(rpcRequest({
      workspaceId,
      agentPreset: REMOTE_PRESET_ID,
    })),
  );
  return {
    ok: true,
    remote: true,
    workspaceId,
    sessionId: created.sessionId,
    alias: manifest.alias,
    remotePath: manifest.remotePath,
    agentPreset: REMOTE_PRESET_ID,
    reused: false,
  };
}
