import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadSshHosts, MIN_REMOTE_NODE } from './config.mjs';
import {
  listRemoteFiles,
  openRemoteFileStream,
  parseHttpByteRange,
  readRemoteFile,
  remoteFileMetadata,
} from './files.mjs';
import { HarnessManager } from './manager.mjs';
import { LocalHarnessManager, checkLocalRuntime, listLocalDirectories } from './local-manager.mjs';
import { UnifiedHarnessManager } from './unified-manager.mjs';
import { appearanceStore } from './appearance.mjs';
import { recentWorkspaceStore } from './recent-workspaces.mjs';
import { checkRemote, installPrivateNode22, listRemoteDirectories } from './ssh.mjs';
import { TerminalManager, terminalProfiles } from './terminal-manager.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(here, '../public');
const pdfjsCandidates = [
  process.resourcesPath ? path.resolve(process.resourcesPath, 'pdfjs-dist') : '',
  path.resolve(here, '../node_modules/pdfjs-dist'),
].filter(Boolean);
const pdfjsDirectory = pdfjsCandidates.find((candidate) => existsSync(candidate)) || pdfjsCandidates.at(-1);
const xtermDirectory = path.resolve(here, '../node_modules/@xterm/xterm');
const xtermFitDirectory = path.resolve(here, '../node_modules/@xterm/addon-fit');
const xtermSearchDirectory = path.resolve(here, '../node_modules/@xterm/addon-search');
const xtermWebLinksDirectory = path.resolve(here, '../node_modules/@xterm/addon-web-links');
const pluginDirectory = path.resolve(here, '../harness-plugin');
const remoteManager = new HarnessManager(pluginDirectory);
const localManager = new LocalHarnessManager(pluginDirectory);
const manager = new UnifiedHarnessManager(remoteManager, localManager);
const terminalManager = new TerminalManager();
const bindHost = '127.0.0.1';
const port = Number(process.env.DSH_REMOTE_PORT || 4173);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk.toString('utf8');
    if (raw.length > 1024 * 1024) throw new Error('Request body too large.');
  }
  return raw ? JSON.parse(raw) : {};
}

async function serveFileFromRoot(response, root, pathname, prefix, cacheControl = 'no-cache') {
  const relative = pathname.slice(prefix.length);
  const candidate = path.resolve(root, relative || '.');
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(candidate);
    response.writeHead(200, {
      'content-type': MIME[path.extname(candidate).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
    });
    response.end(data);
  } catch (error) {
    if (error?.code === 'ENOENT') response.writeHead(404).end('Not found');
    else throw error;
  }
}

async function serveStatic(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const candidate = path.resolve(publicDirectory, `.${requested}`);
  if (!candidate.startsWith(`${publicDirectory}${path.sep}`) && candidate !== path.join(publicDirectory, 'index.html')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(candidate);
    response.writeHead(200, {
      'content-type': MIME[path.extname(candidate).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    response.end(data);
  } catch (error) {
    if (error?.code === 'ENOENT') response.writeHead(404).end('Not found');
    else throw error;
  }
}

async function servePdfJsVendor(response, pathname) {
  await serveFileFromRoot(response, pdfjsDirectory, pathname, '/vendor/pdfjs/', 'public, max-age=31536000, immutable');
}

async function serveTerminalVendor(response, pathname) {
  const roots = [
    ['/vendor/xterm/', xtermDirectory],
    ['/vendor/xterm-fit/', xtermFitDirectory],
    ['/vendor/xterm-search/', xtermSearchDirectory],
    ['/vendor/xterm-web-links/', xtermWebLinksDirectory],
  ];
  const match = roots.find(([prefix]) => pathname.startsWith(prefix));
  if (!match) return false;
  await serveFileFromRoot(response, match[1], pathname, match[0], 'public, max-age=31536000, immutable');
  return true;
}

function pdfContentDisposition(name, download) {
  const encoded = encodeURIComponent(name || 'document.pdf');
  return `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encoded}`;
}

async function serveRemotePdf(request, response, url) {
  const host = url.searchParams.get('host');
  const remotePath = url.searchParams.get('path');
  const metadata = await remoteFileMetadata(host, remotePath);
  if (metadata.extension !== '.pdf') {
    json(response, 415, { error: 'PDF streaming endpoint only accepts .pdf files.' });
    return;
  }

  const rangeHeader = request.headers.range;
  const range = parseHttpByteRange(rangeHeader, metadata.size);
  if (!range) {
    response.writeHead(416, {
      'content-range': `bytes */${metadata.size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  const modified = metadata.mtime ? new Date(metadata.mtime) : null;
  const headers = {
    'content-type': 'application/pdf',
    'content-length': String(range.length),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-disposition': pdfContentDisposition(metadata.name, url.searchParams.get('download') === '1'),
    'x-content-type-options': 'nosniff',
    etag: `W/"${metadata.size}-${modified?.getTime() || 0}"`,
  };
  if (modified && !Number.isNaN(modified.getTime())) headers['last-modified'] = modified.toUTCString();
  if (range.partial) headers['content-range'] = `bytes ${range.start}-${range.end}/${metadata.size}`;

  const status = range.partial ? 206 : 200;
  if (request.method === 'HEAD') {
    response.writeHead(status, headers);
    response.end();
    return;
  }

  response.writeHead(status, headers);
  if (range.length === 0) {
    response.end();
    return;
  }

  const child = openRemoteFileStream(host, remotePath, { start: range.start, length: range.length });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });
  child.once('error', (error) => {
    if (!response.destroyed) response.destroy(error);
  });
  child.once('exit', (code) => {
    if (code && !response.destroyed && !response.writableEnded) {
      response.destroy(new Error(stderr.trim() || `SSH PDF stream exited with code ${code}.`));
    }
  });
  request.once('aborted', () => child.kill('SIGTERM'));
  response.once('close', () => {
    if (!child.killed && !response.writableEnded) child.kill('SIGTERM');
  });
  child.stdout.pipe(response);
}

function instanceIdFrom(pathname, suffix = '') {
  const pattern = suffix
    ? new RegExp(`^/api/instances/([^/]+)/${suffix}$`, 'u')
    : /^\/api\/instances\/([^/]+)$/u;
  return pattern.exec(pathname)?.[1];
}

function terminalIdFrom(pathname) {
  return /^\/api\/terminals\/([^/]+)$/u.exec(pathname)?.[1];
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  try {
    if (url.pathname === '/api/health' && request.method === 'GET') {
      json(response, 200, { ok: true, minRemoteNode: MIN_REMOTE_NODE.join('.'), modes: ['local', 'ssh'], terminal: true });
      return;
    }

    if (url.pathname === '/api/hosts' && request.method === 'GET') {
      json(response, 200, await loadSshHosts());
      return;
    }

    if (url.pathname === '/api/local/check' && request.method === 'GET') {
      json(response, 200, await checkLocalRuntime());
      return;
    }

    if (url.pathname === '/api/local/directories' && request.method === 'GET') {
      json(response, 200, await listLocalDirectories(url.searchParams.get('path')));
      return;
    }

    if (url.pathname === '/api/appearance' && request.method === 'GET') {
      json(response, 200, await appearanceStore.get());
      return;
    }

    if (url.pathname === '/api/appearance' && request.method === 'POST') {
      const body = await readJson(request);
      json(response, 200, body.reset === true ? await appearanceStore.reset() : await appearanceStore.set(body));
      return;
    }

    if (url.pathname === '/api/recent-workspaces' && request.method === 'GET') {
      json(response, 200, { items: await recentWorkspaceStore.get() });
      return;
    }

    if (url.pathname === '/api/recent-workspaces' && request.method === 'POST') {
      const entry = await recentWorkspaceStore.remember(await readJson(request));
      json(response, 200, { entry, items: await recentWorkspaceStore.get() });
      return;
    }

    if (url.pathname === '/api/recent-workspaces' && request.method === 'DELETE') {
      const key = url.searchParams.get('key');
      if (key) await recentWorkspaceStore.remove(key);
      else await recentWorkspaceStore.clear();
      json(response, 200, { items: await recentWorkspaceStore.get() });
      return;
    }

    if (url.pathname === '/api/check' && request.method === 'POST') {
      const { host } = await readJson(request);
      json(response, 200, await checkRemote(host));
      return;
    }

    if (url.pathname === '/api/runtime/install' && request.method === 'POST') {
      const { host } = await readJson(request);
      const version = await installPrivateNode22(host);
      json(response, 200, { ok: true, version, check: await checkRemote(host) });
      return;
    }

    if (url.pathname === '/api/directories' && request.method === 'GET') {
      json(response, 200, await listRemoteDirectories(url.searchParams.get('host'), url.searchParams.get('path')));
      return;
    }

    if (url.pathname === '/api/files' && request.method === 'GET') {
      json(response, 200, await listRemoteFiles(url.searchParams.get('host'), url.searchParams.get('path') || '/'));
      return;
    }

    if (url.pathname === '/api/file' && request.method === 'GET') {
      json(response, 200, await readRemoteFile(url.searchParams.get('host'), url.searchParams.get('path')));
      return;
    }

    if (url.pathname === '/api/pdf' && (request.method === 'GET' || request.method === 'HEAD')) {
      await serveRemotePdf(request, response, url);
      return;
    }

    if (url.pathname === '/api/terminal/profiles' && request.method === 'GET') {
      json(response, 200, { profiles: terminalProfiles() });
      return;
    }

    if (url.pathname === '/api/terminals' && request.method === 'GET') {
      json(response, 200, { terminals: terminalManager.list() });
      return;
    }

    if (url.pathname === '/api/terminals' && request.method === 'POST') {
      const body = await readJson(request);
      try {
        json(response, 201, terminalManager.create({
          mode: body.mode,
          host: body.host,
          cwd: body.cwd,
          profile: body.profile,
          cols: body.cols,
          rows: body.rows,
        }));
      } catch (error) {
        json(response, 500, { error: error instanceof Error ? error.message : String(error), terminalId: error?.terminalId });
      }
      return;
    }

    const terminalId = terminalIdFrom(url.pathname);
    if (terminalId && request.method === 'DELETE') {
      const removed = terminalManager.remove(terminalId);
      json(response, removed ? 200 : 404, removed ? { ok: true } : { error: 'Terminal not found.' });
      return;
    }

    if (url.pathname === '/api/launch' && request.method === 'POST') {
      const body = await readJson(request);
      try {
        json(response, 200, await manager.launch({
          mode: body.mode === 'local' ? 'local' : 'ssh',
          host: body.host,
          workspace: body.workspace,
          installRuntime: body.installRuntime !== false,
          enableLocalProxy: body.enableLocalProxy === true,
        }));
      } catch (error) {
        json(response, 500, {
          error: error instanceof Error ? error.message : String(error),
          instanceId: error?.instanceId,
        });
      }
      return;
    }

    if (url.pathname === '/api/instances' && request.method === 'GET') {
      json(response, 200, { instances: manager.list() });
      return;
    }

    const logId = instanceIdFrom(url.pathname, 'logs');
    if (logId && request.method === 'GET') {
      const instance = manager.get(logId);
      if (!instance) json(response, 404, { error: 'Instance not found.' });
      else json(response, 200, { instance, logs: manager.logs(logId) });
      return;
    }

    const usageId = instanceIdFrom(url.pathname, 'usage');
    if (usageId && request.method === 'GET') {
      const usage = manager.usage(usageId);
      if (!usage) json(response, 404, { error: 'Instance not found.' });
      else json(response, 200, usage);
      return;
    }

    const instanceId = instanceIdFrom(url.pathname);
    if (instanceId && request.method === 'DELETE') {
      const stopped = await manager.stop(instanceId);
      json(response, stopped ? 200 : 404, stopped ? { ok: true } : { error: 'Instance not found.' });
      return;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/vendor/pdfjs/')) {
      await servePdfJsVendor(response, url.pathname);
      return;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/vendor/xterm')) {
      if (await serveTerminalVendor(response, url.pathname)) return;
    }

    if (request.method === 'GET') {
      await serveStatic(response, url.pathname);
      return;
    }
    json(response, 404, { error: 'Not found.' });
  } catch (error) {
    if (!response.headersSent) json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    else if (!response.destroyed) response.destroy(error instanceof Error ? error : new Error(String(error)));
  }
});

const terminalWebSockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  let requestUrl;
  try { requestUrl = new URL(request.url ?? '/', `http://${request.headers.host || '127.0.0.1'}`); } catch { socket.destroy(); return; }
  if (requestUrl.pathname !== '/ws/terminal') {
    socket.destroy();
    return;
  }

  let originOk = false;
  try {
    const origin = new URL(String(request.headers.origin || ''));
    originOk = LOOPBACK_HOSTS.has(origin.hostname) && origin.host === request.headers.host;
  } catch {
    originOk = false;
  }
  if (!originOk) {
    socket.destroy();
    return;
  }

  const id = requestUrl.searchParams.get('id');
  const token = requestUrl.searchParams.get('token');
  terminalWebSockets.handleUpgrade(request, socket, head, (websocket) => {
    if (!terminalManager.attach(id, token, websocket)) websocket.close(1008, 'Invalid terminal session');
  });
});

function openBrowser(url) {
  if (process.env.CI || process.argv.includes('--no-open')) return;
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

server.listen(port, bindHost, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${bindHost}:${actualPort}`;
  console.log(`DeepSeek Harness Desktop: ${url}`);
  console.log('Local mode uses your local Node/npm; SSH mode uses your system ssh client and ~/.ssh/config.');
  console.log('Integrated terminal uses xterm.js + node-pty and is bound to this loopback-only launcher.');
  openBrowser(url);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  terminalManager.stopAll();
  await manager.stopAll().catch(() => undefined);
  terminalWebSockets.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { appearanceStore, localManager, manager, recentWorkspaceStore, remoteManager, server, terminalManager };
