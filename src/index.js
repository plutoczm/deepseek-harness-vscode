import { RouteManager } from './network.js';
import { installProcessProxy } from './process.js';
import { installProxyTerminal } from './terminal.js';

export const name = 'dsh-ssh-vpn-bridge';
export const inject = ['sshRemote', 'subprocess'];

export function apply(ctx, config = {}) {
  const routes = new RouteManager(ctx, config);
  void routes.start();
  const restoreProcess = installProcessProxy(ctx, routes);
  const restoreTerminal = installProxyTerminal(ctx, routes);

  // Expose a tiny in-process service for diagnostics and future UI without
  // storing credentials or duplicating SSH configuration.
  ctx.sshVpnBridge = {
    status: () => routes.snapshot(),
    refresh: () => routes.refreshAll(),
    setMode: (mode) => routes.setMode(mode),
  };

  return async () => {
    restoreTerminal();
    restoreProcess();
    delete ctx.sshVpnBridge;
    await routes.stop();
  };
}
