import { prefixShellEnvironment, remoteUriForCwd } from './util.js';

export function installProcessProxy(ctx, routes) {
  const service = ctx.sshRemote;
  const subprocess = ctx.subprocess;
  const originalSpawn = subprocess.spawn;
  const originalSpawnTerminal = subprocess.spawnTerminal;

  function withProxy(spec) {
    const uri = remoteUriForCwd(service, spec?.cwd);
    if (!uri) return spec;
    const env = routes.proxyEnv(uri);
    return env ? { ...spec, env: { ...(spec.env || {}), ...env } } : spec;
  }

  subprocess.spawn = function (spec) {
    return originalSpawn.call(subprocess, withProxy(spec));
  };

  subprocess.spawnTerminal = function (spec) {
    return originalSpawnTerminal.call(subprocess, withProxy(spec));
  };

  const originalConnect = service.connect;
  const originalMaterializeWorkspace = service.materializeWorkspace;
  const originalExec = service.exec;

  service.connect = async function (id) {
    await originalConnect.call(service, id);
    const workspace = service.get(id);
    if (workspace?.uri) await routes.ensure(workspace.uri, { force: true });
  };

  service.materializeWorkspace = async function (...args) {
    const anchor = await originalMaterializeWorkspace.apply(service, args);
    if (anchor?.uri) await routes.ensure(anchor.uri, { force: true });
    return anchor;
  };

  service.exec = async function (id, command) {
    const workspace = service.get(id);
    if (!workspace?.uri) return originalExec.call(service, id, command);
    await routes.ensure(workspace.uri);
    const env = routes.proxyEnv(workspace.uri);
    return originalExec.call(service, id, env ? prefixShellEnvironment(command, env) : command);
  };

  return () => {
    subprocess.spawn = originalSpawn;
    subprocess.spawnTerminal = originalSpawnTerminal;
    service.connect = originalConnect;
    service.materializeWorkspace = originalMaterializeWorkspace;
    service.exec = originalExec;
  };
}
