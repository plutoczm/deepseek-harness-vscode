import { RouteManager } from './network.js';
import { installSystemOpenSshTransport } from './openssh-transport.js';
import { installProcessProxy } from './process.js';
import { installRemoteShellBootstrap } from './terminal.js';

export const name = 'dsh-ssh-vpn-bridge';
export const inject = ['sshRemote', 'subprocess'];

export function apply(ctx, config = {}) {
  // Install this first so the upstream SSH workspace provider keeps its UI,
  // anchors and routing model while every actual remote data/auth path uses
  // the same system OpenSSH client as `ssh <alias>`.
  const restoreTransport = installSystemOpenSshTransport(ctx);
  const routes = new RouteManager(ctx, config);
  void routes.start();
  const restoreProcess = installProcessProxy(ctx, routes);
  const restoreShell = installRemoteShellBootstrap(ctx, routes);

  return async () => {
    restoreShell();
    restoreProcess();
    await routes.stop();
    restoreTransport();
  };
}
