import { parseSshUri, prefixShellEnvironment, remoteUriForCwd, shellQuote } from './util.js';

const IDLE_MS = 400;
const TIMEOUT_MS = 30_000;
const SCROLLBACK_MAX = 64 * 1024;

function tail(text, max) {
  return text.length > max ? text.slice(text.length - max) : text;
}

class SendOperation {
  constructor(onCancel, onSettle, getStatus) {
    this.onCancel = onCancel;
    this.onSettle = onSettle;
    this.getStatus = getStatus;
    this.output = '';
    this.cursor = 0;
    this.settled = false;
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    this.deadline = setTimeout(() => this.settle('timeout'), TIMEOUT_MS);
    this.resetIdle();
  }

  append(text) {
    if (this.settled) return;
    this.output += text;
    this.resetIdle();
  }

  resetIdle() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.settle('inferred_idle'), IDLE_MS);
  }

  readOutput() {
    const delta = this.output.slice(this.cursor);
    this.cursor = this.output.length;
    return { delta, truncated: false };
  }

  settle(waitReason) {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.idle);
    clearTimeout(this.deadline);
    this.onSettle();
    this.resolveDone({ viewport: this.output, waitReason, sessionStatus: this.getStatus(), truncated: false });
  }

  fail(error) {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.idle);
    clearTimeout(this.deadline);
    this.onSettle();
    this.rejectDone(error);
  }

  cancel() {
    if (this.settled) return false;
    this.onCancel();
    return true;
  }
}

class ProxyTerminalSession {
  constructor(channel) {
    this.channel = channel;
    this.motd = '';
    this.pid = undefined;
    this.scrollback = '';
    this.statusValue = { kind: 'running' };
    this.active = undefined;
    this.closed = false;
    channel.on('data', (data) => this.onData(data.toString('utf8')));
    channel.on('close', () => this.onClose());
    channel.on('error', () => this.onClose());
  }

  onData(text) {
    this.scrollback = tail(this.scrollback + text, SCROLLBACK_MAX);
    this.active?.append(text);
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    this.statusValue = { kind: 'exited', exitCode: null, signal: null };
    this.active?.settle('session_exit');
  }

  startSend(request) {
    if (this.closed) throw new Error('PTY session has exited');
    if (this.active) throw new Error('PTY session already has an active send');
    const operation = new SendOperation(
      () => this.channel.signal('INT'),
      () => { if (this.active === operation) this.active = undefined; },
      () => this.statusValue,
    );
    this.active = operation;
    if (request.text) this.channel.write(request.text);
    if (request.submit) this.channel.write('\r');
    return operation;
  }

  read(request = {}) {
    const lines = this.scrollback.length === 0 ? [] : this.scrollback.split('\n');
    const totalLines = lines.length;
    const offset = request.offset ?? 0;
    const count = request.count ?? 500;
    const start = Math.max(0, totalLines - offset - count);
    const end = Math.max(start, totalLines - offset);
    return {
      text: lines.slice(start, end).join('\n'),
      totalLines,
      lineBegin: offset,
      lineEnd: offset + (end - start),
      truncated: this.scrollback.length >= SCROLLBACK_MAX,
    };
  }

  async signal(signal) {
    if (this.closed) throw new Error('PTY session has exited');
    this.channel.signal(String(signal).replace(/^SIG/u, ''));
    return { delivered: true, targetPgid: 0 };
  }

  status() {
    return this.statusValue;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.channel.end();
  }
}

class ProxyTerminalBackend {
  constructor(service, routes) {
    this.type = 'ssh-vpn';
    this.service = service;
    this.routes = routes;
  }

  async spawn(spec) {
    const uri = remoteUriForCwd(this.service, spec?.cwd);
    if (!uri) throw new Error('ssh-vpn terminal requires a remote SSH workspace cwd');
    await this.routes.ensure(uri);
    const transport = await this.service.connections.transport(uri);
    const channel = await transport.shell({ cols: 80, rows: 24 });
    const target = parseSshUri(uri);
    const env = this.routes.proxyEnv(uri);
    const bootstrap = prefixShellEnvironment(`cd ${shellQuote(target.path)}`, env || {});
    channel.write(`${bootstrap}\r`);
    return new ProxyTerminalSession(channel);
  }
}

export function installProxyTerminal(ctx, routes) {
  const terminals = ctx.get?.('terminals');
  if (!terminals) return () => {};
  const service = ctx.sshRemote;
  const unregister = terminals.registerBackend(new ProxyTerminalBackend(service, routes));
  const originalSpawn = terminals.spawn;

  terminals.spawn = function (owner, request, signal) {
    const uri = remoteUriForCwd(service, request?.cwd);
    if (!uri) return originalSpawn.call(terminals, owner, request, signal);
    return originalSpawn.call(terminals, owner, { ...request, type: 'ssh-vpn' }, signal);
  };

  return () => {
    terminals.spawn = originalSpawn;
    unregister?.();
  };
}
