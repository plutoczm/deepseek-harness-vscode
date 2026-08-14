import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { isSupportedRemoteNode, validateHost, validateRemotePath } from './config.mjs';

const SSH_OPTIONS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=20',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'StrictHostKeyChecking=accept-new',
];

const PROBE_PREFIX = '__DHR__';

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function runProcess(command, args, { input, timeoutMs = 30000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      return next.length > maxBytes ? next.slice(-maxBytes) : next;
    };

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code, signal });
      } else {
        const detail = stderr.trim() || stdout.trim() || `exit ${code}${signal ? ` (${signal})` : ''}`;
        reject(new Error(detail));
      }
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function runSsh(hostInput, script, options = {}) {
  const host = validateHost(hostInput);
  const bashArgs = options.interactiveShell ? ['bash', '-i', '-s'] : ['bash', '-s'];
  try {
    return await runProcess('ssh', [...SSH_OPTIONS, host, ...bashArgs], {
      input: script,
      timeoutMs: options.timeoutMs ?? 30000,
      maxBytes: options.maxBytes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/permission denied|publickey|batchmode/iu.test(message)) {
      throw new Error(`SSH authentication failed for ${host}. Configure a working key/ssh-agent entry in ~/.ssh/config first.\n${message}`);
    }
    throw error;
  }
}

function parseProbe(text) {
  const result = {};
  for (const line of String(text).split(/\r?\n/u)) {
    if (!line.startsWith(PROBE_PREFIX)) continue;
    const payload = line.slice(PROBE_PREFIX.length);
    const index = payload.indexOf('=');
    if (index <= 0) continue;
    result[payload.slice(0, index)] = payload.slice(index + 1);
  }
  return result;
}

export async function checkRemote(host) {
  const script = String.raw`set +e
ROOT="\${DEEPSEEK_HARNESS_REMOTE_HOME:-$HOME/.deepseek-harness-remote}"
find_conda() {
  if [ -n "\${CONDA_EXE:-}" ] && [ -x "\${CONDA_EXE}" ]; then printf '%s\n' "\${CONDA_EXE}"; return; fi
  if command -v conda >/dev/null 2>&1; then
    _base="$(conda info --base 2>/dev/null)"
    if [ -n "$_base" ] && [ -x "$_base/bin/conda" ]; then printf '%s\n' "$_base/bin/conda"; return; fi
    _cmd="$(type -P conda 2>/dev/null)"
    if [ -n "$_cmd" ]; then printf '%s\n' "$_cmd"; return; fi
  fi
  for c in \
    "$HOME/miniconda3/bin/conda" "$HOME/anaconda3/bin/conda" \
    "$HOME/miniforge3/bin/conda" "$HOME/mambaforge/bin/conda" \
    "$HOME/miniconda/bin/conda" "$HOME/anaconda/bin/conda" \
    "/opt/miniconda3/bin/conda" "/opt/conda/bin/conda"; do
    if [ -x "$c" ]; then printf '%s\n' "$c"; return; fi
  done
}
printf '${PROBE_PREFIX}hostname=%s\n' "$(hostname 2>/dev/null)"
printf '${PROBE_PREFIX}home=%s\n' "$HOME"
printf '${PROBE_PREFIX}os=%s\n' "$(uname -s 2>/dev/null)"
printf '${PROBE_PREFIX}arch=%s\n' "$(uname -m 2>/dev/null)"
printf '${PROBE_PREFIX}node=%s\n' "$(node -v 2>/dev/null)"
printf '${PROBE_PREFIX}nodePath=%s\n' "$(command -v node 2>/dev/null)"
printf '${PROBE_PREFIX}npm=%s\n' "$(npm -v 2>/dev/null)"
printf '${PROBE_PREFIX}npmPath=%s\n' "$(command -v npm 2>/dev/null)"
printf '${PROBE_PREFIX}npxPath=%s\n' "$(command -v npx 2>/dev/null)"
printf '${PROBE_PREFIX}privateNode=%s\n' "$([ -x "$ROOT/runtime/node/bin/node" ] && "$ROOT/runtime/node/bin/node" -v 2>/dev/null)"
printf '${PROBE_PREFIX}python=%s\n' "$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
printf '${PROBE_PREFIX}conda=%s\n' "$(find_conda)"
printf '${PROBE_PREFIX}condaBase=%s\n' "$(conda info --base 2>/dev/null)"
exit
`;
  const { stdout } = await runSsh(host, script, { timeoutMs: 20000, interactiveShell: true });
  const values = parseProbe(stdout);
  return {
    ...values,
    systemNodeSupported: isSupportedRemoteNode(values.node),
    privateNodeSupported: isSupportedRemoteNode(values.privateNode),
    ready: isSupportedRemoteNode(values.privateNode) || isSupportedRemoteNode(values.node),
  };
}

export async function installPrivateNode22(host) {
  const script = String.raw`set -euo pipefail
ROOT="\${DEEPSEEK_HARNESS_REMOTE_HOME:-$HOME/.deepseek-harness-remote}"
TARGET="$ROOT/runtime/node"
mkdir -p "$ROOT/runtime"
if [ -x "$TARGET/bin/node" ]; then
  printf '%s\n' "$($TARGET/bin/node -v)"
  exit 0
fi
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported Linux architecture: $(uname -m)" >&2; exit 2 ;;
esac
BASE='https://nodejs.org/dist/latest-v22.x'
if command -v curl >/dev/null 2>&1; then
  INDEX="$(curl -fsSL "$BASE/")"
elif command -v wget >/dev/null 2>&1; then
  INDEX="$(wget -qO- "$BASE/")"
else
  echo 'Neither curl nor wget is available on the remote host.' >&2
  exit 3
fi
FILE="$(printf '%s' "$INDEX" | grep -o "node-v22\\.[0-9.]*-linux-\${ARCH}\\.tar\\.xz" | head -n 1)"
if [ -z "$FILE" ]; then
  echo "Could not locate latest Node 22 binary for linux-\${ARCH}." >&2
  exit 4
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 2 -o "$TMP/node.tar.xz" "$BASE/$FILE"
else
  wget -qO "$TMP/node.tar.xz" "$BASE/$FILE"
fi
tar -xJf "$TMP/node.tar.xz" -C "$TMP"
EXTRACTED="$TMP/\${FILE%.tar.xz}"
rm -rf "$TARGET"
mv "$EXTRACTED" "$TARGET"
printf '%s\n' "$($TARGET/bin/node -v)"
`;
  const { stdout } = await runSsh(host, script, { timeoutMs: 180000 });
  const version = stdout.trim().split(/\r?\n/u).at(-1) ?? '';
  if (!isSupportedRemoteNode(version)) {
    throw new Error(`Private Node installation completed but returned unsupported version: ${version || '(unknown)'}`);
  }
  return version;
}

export async function listRemoteDirectories(host, remotePathInput) {
  const remotePath = validateRemotePath(remotePathInput);
  const quoted = shellQuote(remotePath);
  const script = `set -e\nTARGET=${quoted}\nif [ ! -d "$TARGET" ]; then echo "Remote directory does not exist: $TARGET" >&2; exit 2; fi\nprintf '__CURRENT__=%s\\n' "$(cd "$TARGET" && pwd -P)"\nfind "$TARGET" -mindepth 1 -maxdepth 1 -type d -printf '%f\\t%p\\n' 2>/dev/null | sort\n`;
  const { stdout } = await runSsh(host, script, { timeoutMs: 30000 });
  let current = remotePath;
  const directories = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith('__CURRENT__=')) {
      current = line.slice('__CURRENT__='.length);
      continue;
    }
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab > 0) directories.push({ name: line.slice(0, tab), path: line.slice(tab + 1) });
  }
  return { current, directories };
}

async function ensureRemotePluginDirectory(host) {
  await runSsh(host, 'set -e\nmkdir -p "$HOME/.deepseek-harness-remote/plugin"\n', { timeoutMs: 15000 });
}

async function scpFile(host, localPath) {
  const name = path.basename(localPath);
  await runProcess('scp', [
    '-q',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    localPath,
    `${validateHost(host)}:.deepseek-harness-remote/plugin/${name}`,
  ], { timeoutMs: 30000 });
}

export async function deployPlugin(host, pluginDirectory) {
  await ensureRemotePluginDirectory(host);
  for (const filename of [
    'index.js',
    'package.json',
    'cordis.patch.yml',
    'bash-env.sh',
    'usage-cost.js',
    'usage-package.json',
  ]) {
    const localPath = path.join(pluginDirectory, filename);
    await fs.access(localPath);
    await scpFile(host, localPath);
  }
  await runSsh(host, 'set -e\nchmod 700 "$HOME/.deepseek-harness-remote/plugin/bash-env.sh"\n', { timeoutMs: 15000 });
}

export async function resolveRemoteNode(host, { installIfMissing = true } = {}) {
  let info = await checkRemote(host);
  if (info.privateNodeSupported) {
    return {
      path: '$HOME/.deepseek-harness-remote/runtime/node/bin',
      version: info.privateNode,
      source: 'private',
      condaPath: info.conda || '',
      info,
    };
  }
  if (info.systemNodeSupported) {
    const runtimeBin = info.nodePath?.startsWith('/') ? path.posix.dirname(info.nodePath) : '';
    return {
      path: runtimeBin,
      version: info.node,
      source: runtimeBin && runtimeBin !== '/usr/bin' && runtimeBin !== '/usr/local/bin' ? 'shell' : 'system',
      condaPath: info.conda || '',
      info,
    };
  }
  if (!installIfMissing) {
    return {
      path: undefined,
      version: info.node || info.privateNode,
      source: 'missing',
      condaPath: info.conda || '',
      info,
    };
  }
  const version = await installPrivateNode22(host);
  info = await checkRemote(host);
  return {
    path: '$HOME/.deepseek-harness-remote/runtime/node/bin',
    version,
    source: 'private',
    condaPath: info.conda || '',
    info,
  };
}

export async function findRemoteFreePort(host, runtimeBin = '') {
  const pathPrefix = runtimeBin ? `export PATH=${shellQuote(runtimeBin)}:"$PATH"\n` : '';
  const script = `${pathPrefix}node - <<'NODE'\nconst net = require('node:net');\nconst server = net.createServer();\nserver.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close(); });\nNODE\n`;
  const { stdout } = await runSsh(host, script, { timeoutMs: 15000 });
  const port = Number(stdout.trim().split(/\s+/u).at(-1));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Could not allocate remote port: ${stdout.trim()}`);
  }
  return port;
}

export function findLocalFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function normalizeSshStderr(chunk, onLog) {
  const text = String(chunk);
  if (!/remote port forwarding failed for listen port/iu.test(text)) {
    onLog?.(text);
    return;
  }
  const kept = text
    .split(/\r?\n/u)
    .filter((line) => line && !/remote port forwarding failed for listen port/iu.test(line));
  onLog?.('[ssh] Ignored a failed RemoteForward inherited from ~/.ssh/config; the Harness local tunnel will continue.\n');
  if (kept.length) onLog?.(`${kept.join('\n')}\n`);
}

export function createHarnessTunnel({ host, workspace, localPort, remotePort, runtimeBin, condaPath, onLog, onStdout, instanceId }) {
  validateHost(host);
  validateRemotePath(workspace);

  const runtimePrefix = runtimeBin ? `export PATH=${shellQuote(runtimeBin)}:"$PATH"` : ':';
  const condaBin = condaPath?.startsWith('/') ? path.posix.dirname(condaPath) : '';
  const condaPrefix = condaBin
    ? `export PATH=${shellQuote(condaBin)}:"$PATH"`
    : `for CONDA_BIN in "$HOME/miniconda3/bin" "$HOME/anaconda3/bin" "$HOME/miniforge3/bin" "$HOME/mambaforge/bin" "$HOME/miniconda/bin" "$HOME/anaconda/bin" "/opt/miniconda3/bin" "/opt/conda/bin"; do\n  if [ -x "$CONDA_BIN/conda" ]; then export PATH="$CONDA_BIN:$PATH"; break; fi\ndone`;

  const workspaceQuoted = shellQuote(workspace);
  const remotePortQuoted = shellQuote(String(remotePort));
  const instanceQuoted = shellQuote(instanceId);
  const script = `set -euo pipefail\nROOT="\${DEEPSEEK_HARNESS_REMOTE_HOME:-$HOME/.deepseek-harness-remote}"\nPLUGIN="$ROOT/plugin"\n${condaPrefix}\n${runtimePrefix}\nexport DSH_HOME="\${DSH_HOME:-$HOME/.dsh}"\nSESSION_PACKAGE_DIR="$DSH_HOME/profiles/node_modules/deepseek-harness-remote-session-env"\nUSAGE_PACKAGE_DIR="$DSH_HOME/profiles/node_modules/deepseek-harness-remote-usage-cost"\nmkdir -p "$SESSION_PACKAGE_DIR" "$USAGE_PACKAGE_DIR" "$ROOT/session-env" "$ROOT/logs"\ncp "$PLUGIN/index.js" "$PLUGIN/package.json" "$SESSION_PACKAGE_DIR/"\ncp "$PLUGIN/usage-cost.js" "$USAGE_PACKAGE_DIR/index.js"\ncp "$PLUGIN/usage-package.json" "$USAGE_PACKAGE_DIR/package.json"\nexport DEEPSEEK_HARNESS_PARENT_BASH_ENV="\${BASH_ENV:-}"\nexport BASH_ENV="$PLUGIN/bash-env.sh"\nexport DEEPSEEK_HARNESS_SESSION_ENV_DIR="$ROOT/session-env"\nexport DEEPSEEK_HARNESS_BASE_PATH="$PATH"\nexport DEEPSEEK_HARNESS_REMOTE_INSTANCE=${instanceQuoted}\ncd ${workspaceQuoted}\necho "[remote] workspace=$(pwd -P)"\necho "[remote] node=$(node -v)"\necho "[remote] node_path=$(command -v node)"\necho "[remote] conda=$(command -v conda 2>/dev/null || true)"\necho "[remote] harness_port=${remotePort}"\nexec npx --yes @deepseek-ai/dsh --profile web --patch "$PLUGIN/cordis.patch.yml" --port ${remotePortQuoted}\n`;

  // A user's ~/.ssh/config may contain RemoteForward entries that are unrelated
  // to Harness. If one of those ports is already occupied, ExitOnForwardFailure
  // must not tear down our otherwise healthy local (-L) Harness tunnel.
  const child = spawn('ssh', [
    ...SSH_OPTIONS,
    '-T',
    '-o', 'ExitOnForwardFailure=no',
    '-L', `${localPort}:127.0.0.1:${remotePort}`,
    host,
    'bash', '-s',
  ], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (onStdout ?? onLog)?.(String(chunk)));
  child.stderr.on('data', (chunk) => normalizeSshStderr(chunk, onLog));
  child.stdin.end(script);
  return child;
}

export function waitForHttp(port, { timeoutMs = 180000, child } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (child && child.exitCode !== null) {
        reject(new Error(`SSH/Harness process exited before the Web UI became ready (code ${child.exitCode}).`));
        return;
      }
      const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (response) => {
        response.resume();
        resolve();
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for Harness on local port ${port}.`));
        } else {
          setTimeout(tryOnce, 400);
        }
      });
    };
    tryOnce();
  });
}
