import { RouteManager } from './network.js';
import { installSystemOpenSshTransport } from './openssh-transport.js';
import { installProcessProxy } from './process.js';
import { installRemoteShellBootstrap } from './terminal.js';

export const name = 'dsh-ssh-vpn-bridge';

// subprocess belongs to the stock Harness profile and is required for the
// bridge itself. sshRemote is deliberately NOT a hard plugin dependency:
// out-of-tree SSH providers can be disabled, removed, or hot-reloaded by the
// user. A hard `inject = ['sshRemote']` leaves this loader entry permanently
// pending when the provider is absent and can make the entire profile fail to
// boot. The nested ctx.inject below activates the transport/network layer only
// while sshRemote is actually present.
export const inject = ['subprocess'];

function activateBridge(ctx, config) {
  // Install this first so the SSH workspace provider keeps its UI, anchors
  // and routing model while every actual remote data/auth path uses the same
  // system OpenSSH client as `ssh <alias>`.
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

export function apply(ctx, config = {}) {
  // Cordis owns this dependency scope. If sshRemote appears after this plugin
  // (or is hot-reloaded), the bridge activates automatically; if it
  // disappears, Cordis disposes the nested scope without taking down Harness.
  const sshScope = ctx.inject(['sshRemote'], (sshCtx) => activateBridge(sshCtx, config));

  return async () => {
    await sshScope.dispose();
  };
}
