import { parseSshUri, prefixShellEnvironment, shellQuote } from './util.js';

/**
 * dsh-ssh-remote already owns the `ssh` terminal backend and routes remote
 * workspaces to it. Registering a second backend here would race/lose against
 * that router. Instead, decorate the connection manager's returned transport
 * so only `transport.shell()` receives our route preflight + shell bootstrap.
 * Other transport methods (SFTP/exec) stay bound to the original object.
 */
export function installRemoteShellBootstrap(ctx, routes) {
  const service = ctx.sshRemote;
  const connections = service.connections;
  const originalTransport = connections.transport;

  connections.transport = async function (uri, ...args) {
    const transport = await originalTransport.call(connections, uri, ...args);

    return new Proxy(transport, {
      get(target, property) {
        if (property === 'shell' && typeof target.shell === 'function') {
          return async (...shellArgs) => {
            await routes.ensure(uri);
            const channel = await target.shell.apply(target, shellArgs);
            const remote = parseSshUri(uri);
            const environment = routes.proxyEnv(uri) || {};
            const bootstrap = prefixShellEnvironment(`cd ${shellQuote(remote.path)}`, environment);
            channel.write(`${bootstrap}\r`);
            return channel;
          };
        }

        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  return () => {
    connections.transport = originalTransport;
  };
}
