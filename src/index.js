import { OpenSshEngine } from './engine.js';
import { RouteManager } from './network.js';
import { allOpenSshTools } from './tools.js';

export const name = 'dsh-openssh-vpn';
export const inject = ['tools'];

const GUIDANCE = [
  'Native OpenSSH SSH/VPN tools are available through openssh_list, openssh_exec, openssh_proxy_status, openssh_upload and openssh_download.',
  'These tools intentionally use the operating system ssh/scp executables and the user\'s real ~/.ssh/config rather than a second Node ssh2 credential stack.',
  'For ordinary commands ClearAllForwardings=yes is used so VS Code and Harness do not compete for configured RemoteForward ports.',
  'Network policy is direct-first; if remote GitHub direct access fails, an already-live RemoteForward targeting the Windows proxy is reused before Harness starts its own reverse tunnel.',
].join(' ');

export function apply(ctx, config = {}) {
  const routes = new RouteManager(ctx, config);
  routes.start();
  const engine = new OpenSshEngine(routes);
  const disposers = allOpenSshTools(engine).map((tool) => ctx.tools.register(tool));

  let disposePrompt;
  try {
    const systemPrompt = ctx.get?.('systemPrompt');
    if (systemPrompt?.section) {
      disposePrompt = systemPrompt.section({
        name: 'plugin:dsh-openssh-vpn',
        order: 150,
        text: GUIDANCE,
      });
    }
  } catch {
    // systemPrompt is optional; the tools remain fully functional without it.
  }

  return async () => {
    disposePrompt?.();
    for (const dispose of disposers.reverse()) dispose?.();
    await routes.stop();
  };
}
