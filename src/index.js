import { OpenSshEngine } from './engine.js';
import { RouteManager } from './network.js';
import { allOpenSshTools } from './tools.js';
import { installOpenSshRuntime } from './runtime.js';
import {
  listRemoteWorkspaces,
  openRemoteWorkspace,
} from './remote-workspace.js';

export const name = 'dsh-openssh-vpn';
export const inject = ['tools', 'webServer'];

const API = '/dsh-openssh-vpn/api';
const API_HEADER = 'x-dsh-openssh-vpn';
const GUIDANCE = [
  'Native OpenSSH SSH/VPN tools are available through openssh_list, openssh_exec, openssh_proxy_status, openssh_upload and openssh_download.',
  'These tools intentionally use the operating system ssh/scp executables and the user\'s real ~/.ssh/config rather than a second Node ssh2 credential stack.',
  'For ordinary commands ClearAllForwardings=yes is used so VS Code and Harness do not compete for configured RemoteForward ports.',
  'Network policy is direct-first; if remote GitHub direct access fails, an already-live RemoteForward targeting the Windows proxy is reused before Harness starts its own reverse tunnel.',
  'SSH projects can be registered as Harness remote workspaces; Harness stores only a tiny local anchor while the openssh-remote agent preset executes project commands and file I/O on the mapped SSH host.',
].join(' ');

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJson(req, maxBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function apiGuard(req) {
  return req.headers?.[API_HEADER] === '1';
}

function registerWebApi(ctx, routes, engine) {
  const webServer = ctx.webServer;
  if (!webServer?.register) return undefined;

  return webServer.register({
    kind: 'prefix',
    path: API,
    handler: async (req, res) => {
      if (!apiGuard(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' });

      let url;
      try {
        url = new URL(req.url, 'http://127.0.0.1');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'bad url' });
      }

      const path = url.pathname;
      try {
        if (req.method === 'GET' && path === `${API}/health`) {
          return sendJson(res, 200, { ok: true, name, mode: routes.mode });
        }

        if (req.method === 'GET' && path === `${API}/aliases`) {
          const aliases = await engine.list('');
          return sendJson(res, 200, { ok: true, aliases, mode: routes.mode });
        }

        if (req.method === 'GET' && path === `${API}/status`) {
          const alias = String(url.searchParams.get('alias') || '').trim();
          if (!alias) return sendJson(res, 400, { ok: false, error: 'alias is required' });
          const refresh = url.searchParams.get('refresh') !== '0';
          const status = await engine.proxyStatus(alias, { refresh });
          return sendJson(res, 200, { ok: true, status });
        }

        if (req.method === 'POST' && path === `${API}/mode`) {
          const body = await readJson(req);
          const mode = String(body.mode || '').trim().toLowerCase();
          routes.setMode(mode);
          const alias = String(body.alias || '').trim();
          let status;
          if (alias) {
            await routes.ensure(alias, { force: true });
            status = await engine.proxyStatus(alias, { refresh: false });
          }
          return sendJson(res, 200, { ok: true, mode: routes.mode, status });
        }

        if (req.method === 'POST' && path === `${API}/exec`) {
          const body = await readJson(req);
          const alias = String(body.alias || '').trim();
          const command = String(body.command || '');
          if (!alias) return sendJson(res, 400, { ok: false, error: 'alias is required' });
          if (!command.trim()) return sendJson(res, 400, { ok: false, error: 'command is required' });
          const timeoutMs = Number(body.timeoutMs) > 0 ? Math.min(Number(body.timeoutMs), 10 * 60_000) : 120_000;
          const result = await engine.exec(alias, command, timeoutMs);
          return sendJson(res, 200, { ok: true, result });
        }

        if (req.method === 'GET' && path === `${API}/workspaces`) {
          const workspaces = await listRemoteWorkspaces(ctx);
          return sendJson(res, 200, { ok: true, workspaces });
        }

        if (req.method === 'POST' && path === `${API}/workspace/open`) {
          const body = await readJson(req);
          const alias = String(body.alias || '').trim();
          const remotePath = String(body.remotePath || '').trim();
          if (!alias) return sendJson(res, 400, { ok: false, error: 'alias is required' });
          if (!remotePath) return sendJson(res, 400, { ok: false, error: 'remotePath is required' });
          const workspace = await openRemoteWorkspace(ctx, engine, alias, remotePath);
          return sendJson(res, 200, workspace);
        }

        return sendJson(res, 404, { ok: false, error: 'unknown api' });
      } catch (error) {
        return sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}

export function apply(ctx, config = {}) {
  const routes = new RouteManager(ctx, config);
  routes.start();
  const engine = new OpenSshEngine(routes);
  const disposeRuntime = installOpenSshRuntime({ engine, routes });
  const disposers = allOpenSshTools(engine).map((tool) => ctx.tools.register(tool));
  const disposeWebApi = registerWebApi(ctx, routes, engine);

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
    // systemPrompt is optional; the tools and Web UI remain functional without it.
  }

  return async () => {
    disposePrompt?.();
    disposeWebApi?.();
    for (const dispose of disposers.reverse()) dispose?.();
    disposeRuntime?.();
    await routes.stop();
  };
}
