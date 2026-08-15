import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';

const MAX_BUFFER_CHARS = 512 * 1024;
const MIN_COLS = 20;
const MIN_ROWS = 4;
const MAX_COLS = 500;
const MAX_ROWS = 200;

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function shQuote(value) {
  return `'${String(value ?? '').replaceAll("'", `'"'"'`)}'`;
}

function defaultLocalProfile() {
  if (process.platform === 'win32') return 'powershell';
  return 'default';
}

function localLaunch(profile = defaultLocalProfile()) {
  const selected = String(profile || defaultLocalProfile()).toLowerCase();
  if (process.platform === 'win32') {
    if (selected === 'cmd') return { command: process.env.COMSPEC || 'cmd.exe', args: [], label: 'Command Prompt' };
    if (selected === 'pwsh') return { command: 'pwsh.exe', args: ['-NoLogo'], label: 'PowerShell 7' };
    if (selected === 'git-bash') return { command: 'bash.exe', args: ['-l'], label: 'Git Bash' };
    return { command: 'powershell.exe', args: ['-NoLogo'], label: 'Windows PowerShell' };
  }
  const shell = process.env.SHELL || '/bin/bash';
  return { command: shell, args: ['-l'], label: path.basename(shell) || 'Shell' };
}

function sshLaunch(host, cwd) {
  const remoteCommand = cwd
    ? `cd -- ${shQuote(cwd)} && exec \"\${SHELL:-/bin/bash}\" -l`
    : 'exec "${SHELL:-/bin/bash}" -l';
  return {
    command: process.platform === 'win32' ? 'ssh.exe' : 'ssh',
    args: ['-tt', host, remoteCommand],
    label: `SSH · ${host}`,
  };
}

function cleanEnv() {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, value]),
  );
}

export function terminalProfiles() {
  if (process.platform === 'win32') {
    return [
      { id: 'powershell', label: 'Windows PowerShell', recommended: true },
      { id: 'pwsh', label: 'PowerShell 7' },
      { id: 'cmd', label: 'Command Prompt' },
      { id: 'git-bash', label: 'Git Bash' },
    ];
  }
  const shell = process.env.SHELL || '/bin/bash';
  return [{ id: 'default', label: path.basename(shell) || shell, recommended: true }];
}

export class TerminalManager {
  constructor() {
    this.terminals = new Map();
  }

  publicTerminal(terminal, includeToken = false) {
    if (!terminal) return undefined;
    return {
      id: terminal.id,
      mode: terminal.mode,
      host: terminal.host,
      cwd: terminal.cwd,
      profile: terminal.profile,
      title: terminal.title,
      status: terminal.status,
      pid: terminal.pid,
      createdAt: terminal.createdAt,
      exitedAt: terminal.exitedAt,
      exitCode: terminal.exitCode,
      cols: terminal.cols,
      rows: terminal.rows,
      ...(includeToken ? { token: terminal.token } : {}),
    };
  }

  list() {
    return [...this.terminals.values()].map((terminal) => this.publicTerminal(terminal));
  }

  get(id) {
    return this.terminals.get(id);
  }

  create({ mode = 'local', host, cwd, profile, cols = 120, rows = 30 } = {}) {
    const normalizedMode = mode === 'ssh' ? 'ssh' : 'local';
    const normalizedHost = normalizedMode === 'ssh' ? String(host || '').trim() : 'Local';
    if (normalizedMode === 'ssh' && !normalizedHost) throw new Error('SSH terminal requires a host.');

    const normalizedCwd = String(cwd || '').trim() || (normalizedMode === 'local' ? os.homedir() : '');
    const launch = normalizedMode === 'ssh'
      ? sshLaunch(normalizedHost, normalizedCwd)
      : localLaunch(profile);
    const normalizedCols = clamp(cols, MIN_COLS, MAX_COLS, 120);
    const normalizedRows = clamp(rows, MIN_ROWS, MAX_ROWS, 30);

    const terminal = {
      id: randomUUID(),
      token: randomBytes(24).toString('base64url'),
      mode: normalizedMode,
      host: normalizedHost,
      cwd: normalizedCwd,
      profile: normalizedMode === 'local' ? (profile || defaultLocalProfile()) : 'ssh',
      title: launch.label,
      status: 'starting',
      pid: undefined,
      createdAt: new Date().toISOString(),
      exitedAt: undefined,
      exitCode: undefined,
      cols: normalizedCols,
      rows: normalizedRows,
      buffer: '',
      clients: new Set(),
      pty: undefined,
    };
    this.terminals.set(terminal.id, terminal);

    try {
      const shell = pty.spawn(launch.command, launch.args, {
        name: 'xterm-256color',
        cols: normalizedCols,
        rows: normalizedRows,
        cwd: normalizedMode === 'local' ? normalizedCwd : os.homedir(),
        env: cleanEnv(),
        encoding: 'utf8',
      });
      terminal.pty = shell;
      terminal.pid = shell.pid;
      terminal.status = 'running';

      shell.onData((data) => {
        terminal.buffer += data;
        if (terminal.buffer.length > MAX_BUFFER_CHARS) terminal.buffer = terminal.buffer.slice(-MAX_BUFFER_CHARS);
        const message = JSON.stringify({ type: 'data', data });
        for (const client of terminal.clients) {
          if (client.readyState === 1) client.send(message);
        }
      });
      shell.onExit(({ exitCode, signal }) => {
        terminal.status = 'exited';
        terminal.exitCode = exitCode;
        terminal.signal = signal;
        terminal.exitedAt = new Date().toISOString();
        const message = JSON.stringify({
          type: 'exit',
          exitCode,
          signal,
          terminal: this.publicTerminal(terminal),
        });
        for (const client of terminal.clients) {
          if (client.readyState === 1) client.send(message);
        }
      });
      return this.publicTerminal(terminal, true);
    } catch (error) {
      terminal.status = 'error';
      terminal.exitedAt = new Date().toISOString();
      terminal.error = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`Unable to start terminal: ${terminal.error}`), { terminalId: terminal.id });
    }
  }

  attach(id, token, socket) {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.token !== token) return false;
    terminal.clients.add(socket);
    socket.send(JSON.stringify({
      type: 'snapshot',
      terminal: this.publicTerminal(terminal),
      buffer: terminal.buffer,
    }));
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message?.type === 'input' && typeof message.data === 'string' && terminal.status === 'running') {
        terminal.pty?.write(message.data);
      } else if (message?.type === 'resize' && terminal.status === 'running') {
        const nextCols = clamp(message.cols, MIN_COLS, MAX_COLS, terminal.cols);
        const nextRows = clamp(message.rows, MIN_ROWS, MAX_ROWS, terminal.rows);
        terminal.cols = nextCols;
        terminal.rows = nextRows;
        terminal.pty?.resize(nextCols, nextRows);
      }
    });
    socket.once('close', () => terminal.clients.delete(socket));
    socket.once('error', () => terminal.clients.delete(socket));
    return true;
  }

  kill(id) {
    const terminal = this.terminals.get(id);
    if (!terminal) return false;
    if (terminal.status === 'running' || terminal.status === 'starting') {
      try { terminal.pty?.kill(); } catch { /* already gone */ }
    }
    terminal.status = terminal.status === 'error' ? 'error' : 'exited';
    terminal.exitedAt ||= new Date().toISOString();
    return true;
  }

  remove(id) {
    const terminal = this.terminals.get(id);
    if (!terminal) return false;
    this.kill(id);
    for (const client of terminal.clients) {
      try { client.close(1000, 'Terminal removed'); } catch { /* ignore */ }
    }
    this.terminals.delete(id);
    return true;
  }

  stopAll() {
    for (const id of this.terminals.keys()) this.remove(id);
  }
}
