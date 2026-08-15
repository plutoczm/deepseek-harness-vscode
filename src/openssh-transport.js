import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { parseSshUri, shellQuote } from './util.js';

function sshBaseArgs(uri, terminal = false) {
  const target = parseSshUri(uri);
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    terminal ? '-tt' : '-T',
  ];
  if (target.port !== 22) args.push('-p', String(target.port));
  args.push(target.destination);
  return args;
}

function mapRemoteError(stderr, fallback = 'remote OpenSSH operation failed') {
  const text = String(stderr || '').trim();
  const error = new Error(text || fallback);
  if (/no such file|errno\s*2\b/iu.test(text)) error.code = 'ENOENT';
  else if (/permission denied|errno\s*13\b/iu.test(text)) error.code = 'EACCES';
  else if (/is a directory|errno\s*21\b/iu.test(text)) error.code = 'EISDIR';
  else if (/not a directory|errno\s*20\b/iu.test(text)) error.code = 'ENOTDIR';
  return error;
}

function runRemote(uri, command, { input, timeoutMs = 30_000, maxBytes = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshBaseArgs(uri), '--', command], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    const finish = (error, code = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout: Buffer.concat(stdout), stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`remote OpenSSH operation timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        child.kill();
        finish(new Error(`remote OpenSSH output exceeded ${maxBytes} bytes`));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-128 * 1024); });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code === 0) finish(undefined, code);
      else finish(mapRemoteError(stderr, `ssh exited with code ${String(code)}`), code);
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const PYTHON_PREFIX = `PY=$(command -v python3 2>/dev/null || command -v python 2>/dev/null) || { echo 'python3/python is required by dsh-ssh-vpn-bridge file transport' >&2; exit 127; }; "$PY" -c`;

function pythonCommand(script, ...args) {
  return `${PYTHON_PREFIX} ${shellQuote(script)} ${args.map(shellQuote).join(' ')}`.trim();
}

function statsObject(row) {
  const type = row.type;
  return {
    size: Number(row.size || 0),
    mtime: Number(row.mtime || 0),
    mode: Number(row.mode || 0),
    isFile: () => type === 'file',
    isDirectory: () => type === 'directory',
    isSymbolicLink: () => type === 'symlink',
  };
}

async function jsonRemote(uri, command) {
  const result = await runRemote(uri, command, { maxBytes: 8 * 1024 * 1024 });
  const text = result.stdout.toString('utf8').trim();
  return text ? JSON.parse(text) : undefined;
}

const STAT_SCRIPT = [
  'import json, os, stat, sys',
  'p=sys.argv[1]',
  'follow=(sys.argv[2]=="1")',
  's=os.stat(p, follow_symlinks=follow)',
  'm=s.st_mode',
  't="directory" if stat.S_ISDIR(m) else "file" if stat.S_ISREG(m) else "symlink" if stat.S_ISLNK(m) else "other"',
  'print(json.dumps({"size":s.st_size,"mtime":s.st_mtime,"mode":m,"type":t}))',
].join(';');

const READDIR_SCRIPT = `
import json, os, stat, sys
out=[]
with os.scandir(sys.argv[1]) as it:
  for e in it:
    s=e.stat(follow_symlinks=False)
    m=s.st_mode
    t="directory" if stat.S_ISDIR(m) else "file" if stat.S_ISREG(m) else "symlink" if stat.S_ISLNK(m) else "other"
    out.append({"filename":e.name,"attrs":{"size":s.st_size,"mtime":s.st_mtime,"mode":m,"type":t}})
print(json.dumps(out))
`;

const REALPATH_SCRIPT = 'import os,sys; print(os.path.realpath(sys.argv[1]))';
const READ_SCRIPT = 'import sys; sys.stdout.buffer.write(open(sys.argv[1],"rb").read())';
const WRITE_SCRIPT = 'import sys; open(sys.argv[1],"wb").write(sys.stdin.buffer.read())';
const MKDIR_SCRIPT = 'import os,sys; os.mkdir(sys.argv[1])';
const UNLINK_SCRIPT = 'import os,sys; os.unlink(sys.argv[1])';

function callbackify(promise, callback) {
  promise.then((value) => callback(null, value), (error) => callback(error));
}

function createSftpFacade(uri) {
  return {
    stat(path, callback) {
      callbackify(jsonRemote(uri, pythonCommand(STAT_SCRIPT, path, '1')).then(statsObject), callback);
    },
    lstat(path, callback) {
      callbackify(jsonRemote(uri, pythonCommand(STAT_SCRIPT, path, '0')).then(statsObject), callback);
    },
    readdir(path, callback) {
      callbackify(jsonRemote(uri, pythonCommand(READDIR_SCRIPT, path)).then((rows) =>
        (rows || []).map((row) => ({ filename: row.filename, attrs: statsObject(row.attrs) }))), callback);
    },
    realpath(path, callback) {
      callbackify(runRemote(uri, pythonCommand(REALPATH_SCRIPT, path)).then((result) => result.stdout.toString('utf8').trim()), callback);
    },
    readFile(path, callback) {
      callbackify(runRemote(uri, pythonCommand(READ_SCRIPT, path)).then((result) => result.stdout), callback);
    },
    writeFile(path, data, callback) {
      callbackify(runRemote(uri, pythonCommand(WRITE_SCRIPT, path), { input: Buffer.from(data) }).then(() => undefined), callback);
    },
    mkdir(path, callback) {
      callbackify(runRemote(uri, pythonCommand(MKDIR_SCRIPT, path)).then(() => undefined), callback);
    },
    unlink(path, callback) {
      callbackify(runRemote(uri, pythonCommand(UNLINK_SCRIPT, path)).then(() => undefined), callback);
    },
  };
}

class OpenSshShellChannel extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    child.stdout.on('data', (chunk) => this.emit('data', chunk));
    child.stderr.on('data', (chunk) => this.emit('data', chunk));
    child.once('error', (error) => this.emit('error', error));
    child.once('close', (code, signal) => this.emit('close', code, signal));
  }

  write(data) {
    return this.child.stdin.write(data);
  }

  signal(signal) {
    const name = String(signal || '').replace(/^SIG/u, '').toUpperCase();
    if (name === 'INT') {
      this.child.stdin.write('\x03');
      return;
    }
    if (name === 'TERM') {
      this.child.stdin.write('exit\r');
      return;
    }
    this.child.kill(`SIG${name}`);
  }

  end() {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill();
    }, 750).unref?.();
  }
}

function createTransport(uri) {
  const target = parseSshUri(uri);
  return {
    hostKey: `${target.destination}:${target.port}`,
    uri,
    status: 'connected',
    async sftp(operation) {
      return operation(createSftpFacade(uri));
    },
    async exec(command) {
      try {
        const result = await runRemote(uri, `sh -lc ${shellQuote(command)}`);
        return { code: result.code ?? 0, stdout: result.stdout.toString('utf8'), stderr: result.stderr };
      } catch (error) {
        return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
      }
    },
    async shell() {
      const child = spawn('ssh', sshBaseArgs(uri, true), {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return new OpenSshShellChannel(child);
    },
    close() {},
  };
}

/**
 * Replace only the connection manager's transport factory. The upstream SSH
 * workspace/UI/routing model stays intact, but authentication and data paths
 * are all driven by the same system OpenSSH client the user already tested.
 */
export function installSystemOpenSshTransport(ctx) {
  const connections = ctx.sshRemote.connections;
  const originalTransport = connections.transport;
  const originalClose = connections.close;

  connections.transport = async function (uri) {
    // A cheap non-interactive handshake is intentionally deferred to the
    // first real operation; each operation has its own timeout and diagnostics.
    return createTransport(uri);
  };
  connections.close = async function () {};

  return () => {
    connections.transport = originalTransport;
    connections.close = originalClose;
  };
}
