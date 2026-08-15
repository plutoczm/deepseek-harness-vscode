import { readRemoteWorkspaceManifest, REMOTE_PRESET_ID } from './remote-workspace.js';

const HOOK = Symbol.for('dsh-openssh-vpn.remote-session-create-hook');

/**
 * Harness' native Workspace UI creates a new session by calling
 * apiProxy.sessions.create({ workspaceId }) with no agentPreset. For a normal
 * local Workspace that is correct; for an SSH anchor it would mount the
 * standard Windows coding preset and point file tools at the tiny anchor.
 *
 * Intercept only that one host gateway method. If workspaceId resolves to an
 * anchor carrying our manifest, force openssh-remote. All local Workspaces and
 * non-workspace sessions pass through byte-for-byte. The hook lives on the Host
 * gateway, so every Web entry point (sidebar '+', New Session, reconnect) gets
 * the same behavior without DOM interception.
 */
export function installRemoteSessionCreateHook(ctx) {
  const apiProxy = ctx.get?.('apiProxy');
  const registry = ctx.get?.('workspaceRegistry');
  const sessions = apiProxy?.sessions;

  // The bundle may be inserted before apiProxy/workspaceRegistry in a user's
  // patch order. Cordis ctx.inject is the supported way to wait for optional
  // services, so do not silently skip the hook based on startup timing.
  if (!sessions || typeof sessions.create !== 'function' || !registry?.list) {
    if (typeof ctx.inject !== 'function') return () => {};
    let nestedDispose = () => {};
    let injectionDispose;
    try {
      injectionDispose = ctx.inject(['apiProxy', 'workspaceRegistry'], (readyCtx) => {
        nestedDispose();
        nestedDispose = installRemoteSessionCreateHook(readyCtx);
        readyCtx.on?.('dispose', () => nestedDispose());
      });
    } catch (error) {
      ctx.logger?.warn?.(`dsh-openssh-vpn: could not defer remote Workspace session hook: ${String(error)}`);
      return () => {};
    }
    return () => {
      nestedDispose();
      if (typeof injectionDispose === 'function') injectionDispose();
    };
  }

  if (sessions[HOOK]) return () => {};

  const original = sessions.create;
  const wrapped = async function (request, ...rest) {
    const workspaceId = request?.payload?.workspaceId;
    if (workspaceId !== undefined) {
      let workspace;
      try {
        workspace = registry.list().find((item) => String(item.id) === String(workspaceId));
      } catch {
        workspace = undefined;
      }
      const manifest = workspace?.path ? readRemoteWorkspaceManifest(workspace.path) : undefined;
      if (manifest) {
        const nextRequest = {
          ...request,
          payload: {
            ...request.payload,
            agentPreset: REMOTE_PRESET_ID,
          },
        };
        return original.call(sessions, nextRequest, ...rest);
      }
    }
    return original.call(sessions, request, ...rest);
  };

  try {
    sessions.create = wrapped;
    Object.defineProperty(sessions, HOOK, {
      value: { original, wrapped },
      configurable: true,
    });
  } catch (error) {
    ctx.logger?.warn?.(`dsh-openssh-vpn: could not install remote Workspace session hook: ${String(error)}`);
    return () => {};
  }

  return () => {
    try {
      const installed = sessions[HOOK];
      if (installed?.wrapped === wrapped && sessions.create === wrapped) sessions.create = original;
      delete sessions[HOOK];
    } catch {
      // Host shutdown/hot-reload may already have disposed the gateway.
    }
  };
}
