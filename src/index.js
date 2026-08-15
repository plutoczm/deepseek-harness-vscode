import { RouteManager } from './network.js';
import { installProcessProxy } from './process.js';
import { installRemoteShellBootstrap } from './terminal.js';

export const name = 'dsh-ssh-vpn-bridge';
export const inject = ['sshRemote', 'subprocess'];

export function apply(ctx, config = {}) {
  const routes = new RouteManager(ctx, config);
  void routes.start();
  const restoreProcess = installProcessProxy(ctx, routes);
  const restoreShell = installRemoteShellBootstrap(ctx, routes);

  return async () => {
    restoreShell();
    restoreProcess();
    await routes.stop();
  };
}
